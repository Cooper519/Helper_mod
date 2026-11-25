// 订阅服务仅持有元数据，附件始终流式转发。
package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"regexp"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

type Config struct {
	Listen      string
	AccessToken string
	PluginRepo  string
	GithubRepo  string
	GiteeRepo   string
	GithubToken string
	GiteeToken  string
	CacheTTL    int
}

func loadConfig() (Config, error) {
	c := Config{Listen: ":28473", CacheTTL: 300}
	if p := os.Getenv("FEED_CONFIG"); p != "" {
		b, e := os.ReadFile(p)
		if e != nil {
			return c, e
		}
		if e = json.Unmarshal(b, &c); e != nil {
			return c, e
		}
	}
	for k, p := range map[string]*string{"LISTEN": &c.Listen, "ACCESS_TOKEN": &c.AccessToken, "PLUGIN_REPO": &c.PluginRepo, "GITHUB_REPO": &c.GithubRepo, "GITEE_REPO": &c.GiteeRepo, "GITHUB_TOKEN": &c.GithubToken, "GITEE_TOKEN": &c.GiteeToken} {
		if v, ok := os.LookupEnv(k); ok {
			*p = v
		}
	}
	if v := os.Getenv("CACHE_TTL"); v != "" {
		if _, e := fmt.Sscan(v, &c.CacheTTL); e != nil {
			return c, errors.New("缓存 TTL 无效")
		}
	}
	repo := regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)
	if c.AccessToken == "" || !repo.MatchString(c.PluginRepo) || !repo.MatchString(c.GithubRepo) || (c.GiteeRepo != "" && !repo.MatchString(c.GiteeRepo)) || c.CacheTTL < 1 {
		return c, errors.New("配置缺少密钥、仓库或有效 TTL")
	}
	return c, nil
}

var semver = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`)
var digest = regexp.MustCompile(`^[a-fA-F0-9]{64}$`)

func metadata(body, key string) string {
	for _, line := range strings.Split(body, "\n") {
		if strings.HasPrefix(line, key+":") {
			return strings.TrimSpace(strings.TrimPrefix(line, key+":"))
		}
	}
	return ""
}

var hosts = map[string]bool{"api.github.com": true, "github.com": true, "objects.githubusercontent.com": true, "release-assets.githubusercontent.com": true, "gitee.com": true, "api.gitee.com": true, "foruda.gitee.com": true}

func allowed(u *url.URL) bool { return u.Scheme == "https" && u.User == nil && hosts[u.Host] }
func redirect(r *http.Request, via []*http.Request) error {
	if len(via) >= 10 || !allowed(r.URL) {
		return errors.New("拒绝上游重定向")
	}
	for _, previous := range via {
		if r.URL.Host != previous.URL.Host {
			r.Header.Del("Authorization")
			break
		}
	}
	return nil
}
func client() *http.Client {
	return &http.Client{Transport: &http.Transport{Proxy: http.ProxyFromEnvironment, DialContext: (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext, TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 30 * time.Second}, CheckRedirect: redirect}
}

type asset struct {
	Name     string `json:"name"`
	ID       int64  `json:"id"`
	Size     int64  `json:"size"`
	URL      string `json:"url"`
	Download string `json:"browser_download_url"`
}

func (a *asset) UnmarshalJSON(b []byte) error {
	type raw asset
	v := raw{Size: -1}
	if e := json.Unmarshal(b, &v); e != nil {
		return e
	}
	*a = asset(v)
	return nil
}

type release struct {
	Created    string  `json:"created_at"`
	Tag        string  `json:"tag_name"`
	Published  string  `json:"published_at"`
	Body       string  `json:"body"`
	Draft      bool    `json:"draft"`
	Prerelease bool    `json:"prerelease"`
	Assets     []asset `json:"assets"`
}
type Asset struct {
	Filename string `json:"filename,omitempty"`
	URL      string `json:"url"`
	Size     int64  `json:"size"`
	SHA      string `json:"sha256"`
}
type Component struct {
	Version     string           `json:"version"`
	Tag         string           `json:"tag"`
	Published   string           `json:"publishedAt"`
	Notes       string           `json:"notes"`
	Min         string           `json:"minPluginVersion,omitempty"`
	Recommended string           `json:"recommendedPluginVersion,omitempty"`
	Audio       string           `json:"audioMode,omitempty"`
	Assets      map[string]Asset `json:"assets,omitempty"`
	Asset       *Asset           `json:"asset,omitempty"`
}
type Manifest struct {
	Schema    int       `json:"schema"`
	Generated string    `json:"generatedAt"`
	Source    string    `json:"source"`
	Plugin    Component `json:"plugin"`
	Helper    Component `json:"helper"`
	Resources Component `json:"resources"`
}
type target struct{ URL, Token string }
type cached struct {
	Manifest Manifest
	Targets  map[string]target
	Until    time.Time
}
type refreshCall struct {
	done  chan struct{}
	value cached
	err   error
}
type Feed struct {
	flights map[string]*refreshCall
	cfg     Config
	http    *http.Client
	mu      sync.Mutex
	cache   map[string]cached
	refresh map[string]time.Time
}

func newFeed(c Config, h *http.Client) *Feed {
	return &Feed{cfg: c, http: h, flights: map[string]*refreshCall{}, cache: map[string]cached{}, refresh: map[string]time.Time{}}
}
func (f *Feed) get(ctx context.Context, u, token, accept string) (*http.Response, error) {
	p, e := url.Parse(u)
	if e != nil || !allowed(p) {
		return nil, errors.New("上游地址不允许")
	}
	r, e := http.NewRequestWithContext(ctx, "GET", u, nil)
	if e != nil {
		return nil, e
	}
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	r.Header.Set("Accept", accept)
	return f.http.Do(r)
}
func (f *Feed) small(ctx context.Context, u, token string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	accept := "application/json"
	if strings.Contains(u, "/assets/") {
		accept = "application/octet-stream"
	}
	r, e := f.get(ctx, u, token, accept)
	if e != nil {
		return nil, e
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		return nil, errors.New("上游状态异常")
	}
	b, e := io.ReadAll(io.LimitReader(r.Body, 2*1024*1024+1))
	if len(b) > 2*1024*1024 {
		return nil, errors.New("元数据过大")
	}
	return b, e
}
func (f *Feed) releases(ctx context.Context, source, repo string, kinds ...string) ([]release, error) {
	base, token := "https://api.github.com/repos/", f.cfg.GithubToken
	if source == "gitee" {
		base = "https://gitee.com/api/v5/repos/"
		token = f.cfg.GiteeToken
	}
	// 元数据仅发往本平台 API，复用服务端配额；公开下载仍保持匿名。
	var out []release
	previous := ""
	for page := 1; ; page++ {
		b, e := f.small(ctx, fmt.Sprintf("%s%s/releases?per_page=100&page=%d", base, repo, page), token)
		if e != nil {
			return nil, e
		}
		var rows []release
		if e = json.Unmarshal(b, &rows); e != nil {
			return nil, e
		}
		for _, r := range rows {
			for _, kind := range kinds {
				_, names := candidate(r, kind)
				if len(names) > 0 {
					out = append(out, r)
					break
				}
			}
		}
		if len(rows) < 100 {
			break
		}
		tail := rows[len(rows)-1].Tag
		if tail == previous {
			return nil, errors.New("上游发布分页未前进")
		}
		previous = tail
	}
	return out, nil
}

// 两类私有附件分开记住最新稳定候选；即使资源发布间隔超过一页也能找到。
func candidate(r release, kind string) (string, []string) {
	if r.Draft || r.Prerelease {
		return "", nil
	}
	v := strings.TrimPrefix(r.Tag, "v")
	if kind == "resources" {
		if !strings.HasPrefix(r.Tag, "resources-v") {
			return "", nil
		}
		v = strings.TrimPrefix(r.Tag, "resources-v")
	}
	if !semver.MatchString(v) {
		return "", nil
	}
	names := []string{"main.js", "manifest.json", "styles.css"}
	if kind == "helper" {
		names = []string{"ielts-helper-" + v + ".zip"}
	} else if kind == "resources" {
		names = []string{"ielts-helper-resources-" + v + ".zip"}
	}
	present := map[string]bool{}
	for _, a := range r.Assets {
		present[a.Name] = true
	}
	if !present["checksums.txt"] && !present["SHA256SUMS"] {
		return "", nil
	}
	if kind == "helper" && (!semver.MatchString(metadata(r.Body, "minPluginVersion")) || !semver.MatchString(metadata(r.Body, "recommendedPluginVersion"))) {
		return "", nil
	}
	if kind == "resources" {
		a := metadata(r.Body, "audioMode")
		if a != "on-demand" && a != "offline" && a != "bundled" {
			return "", nil
		}
	}
	if kind == "helper" {
		light := "ielts-helper-light-" + v + ".zip"
		if present[light] {
			// 同标签双格式或纯轻量包均以 light 附件自身摘要与字节交付。
			names = []string{light}
		}
	}
	for _, n := range names {
		if !present[n] {
			return "", nil
		}
	}
	return v, names
}
func assetURL(a asset, source string) string {
	if source == "github" {
		return a.URL
	}
	return a.Download
}

// 元数据提供的下载起点也可能直接指向 CDN；只向对应私有 API 的原始站发送密钥。
func assetToken(raw, source, kind, token string) string {
	u, err := url.Parse(raw)
	if kind == "plugin" || err != nil || !allowed(u) {
		return ""
	}
	if (source == "github" && u.Host == "api.github.com") || (source == "gitee" && u.Host == "gitee.com") {
		return token
	}
	return ""
}

// Gitee 附件没有 size 时只取 HEAD 响应头，绝不下载整包探测。
func (f *Feed) assetSize(ctx context.Context, u, token string) (int64, error) {
	p, e := url.Parse(u)
	if e != nil || !allowed(p) {
		return 0, errors.New("上游地址不允许")
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	r, e := http.NewRequestWithContext(ctx, "HEAD", u, nil)
	if e != nil {
		return 0, e
	}
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	resp, e := f.http.Do(r)
	if e != nil {
		return 0, e
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 || resp.ContentLength < 0 {
		return 0, errors.New("附件大小不可用")
	}
	return resp.ContentLength, nil
}

// 逐段比较十进制文本，避免版本段溢出或把 10 排在 9 之前。
func newer(a, b string) bool {
	x, y := strings.Split(a, "."), strings.Split(b, ".")
	for i := range x {
		l, r := strings.TrimLeft(x[i], "0"), strings.TrimLeft(y[i], "0")
		if len(l) != len(r) {
			return len(l) > len(r)
		}
		if l != r {
			return l > r
		}
	}
	return false
}

var checksumLine = regexp.MustCompile(`^([0-9a-fA-F]{64})[ \t]+\*?(.+)$`)

func checksums(b []byte) map[string]string {
	sums := map[string]string{}
	for _, line := range strings.Split(string(b), "\n") {
		m := checksumLine.FindStringSubmatch(strings.TrimRight(line, "\r"))
		if m != nil {
			if _, exists := sums[m[2]]; exists {
				sums[m[2]] = ""
			} else {
				sums[m[2]] = strings.ToLower(m[1])
			}
		}
	}
	return sums
}

// component 只接受同时具有校验清单和所需附件的稳定 Release。
func (f *Feed) component(ctx context.Context, rs []release, kind, source string) (Component, map[string]target, error) {
	token := f.cfg.GithubToken
	if source == "gitee" {
		token = f.cfg.GiteeToken
	}
	// 不修改共享的上游列表，两种组件各自按完整稳定版本排序。
	candidates := make([]release, 0, len(rs))
	for _, r := range rs {
		if v, _ := candidate(r, kind); v != "" {
			candidates = append(candidates, r)
		}
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		a, _ := candidate(candidates[i], kind)
		b, _ := candidate(candidates[j], kind)
		return newer(a, b)
	})
releasesLoop:
	for _, r := range candidates {
		if r.Published == "" {
			r.Published = r.Created
		}
		v, names := candidate(r, kind)
		if len(names) == 0 {
			continue
		}
		by := map[string]asset{}
		for _, a := range r.Assets {
			by[a.Name] = a
		}
		sum, yes := by["checksums.txt"]
		if !yes {
			sum, yes = by["SHA256SUMS"]
		}
		if !yes {
			continue
		}
		sumURL := assetURL(sum, source)
		b, e := f.small(ctx, sumURL, assetToken(sumURL, source, kind, token))
		if e != nil {
			return Component{}, nil, e
		}
		sums := checksums(b)
		for _, name := range names {
			if sums[name] == "" {
				continue releasesLoop
			}
		}
		c := Component{Version: v, Tag: r.Tag, Published: r.Published, Notes: r.Body}
		ts := map[string]target{}
		if kind == "plugin" {
			c.Assets = map[string]Asset{}
		}
		for _, n := range names {
			a := by[n]
			address := assetURL(a, source)
			u, err := url.Parse(address)
			if err != nil || !allowed(u) {
				return Component{}, nil, errors.New("附件地址无效")
			}
			credential := assetToken(address, source, kind, token)
			if a.Size < 0 {
				size, err := f.assetSize(ctx, address, credential)
				if err != nil {
					return Component{}, nil, err
				}
				a.Size = size
			}
			if sums[n] == "" || a.Size < 0 {
				return Component{}, nil, errors.New("缺少有效校验和")
			}
			filename := n
			if kind == "helper" {
				filename = "ielts-helper-" + v + ".zip" // 老客户端仍按冻结的清单名与路径下载。
			}
			key := kind + "/" + v + "/" + filename
			out := Asset{URL: "/download/" + key, Size: a.Size, SHA: sums[n]}
			if source == "gitee" {
				out.URL += "?source=gitee"
			}
			if kind == "plugin" {
				c.Assets[n] = out
			} else {
				out.Filename = filename
				c.Asset = &out
			}
			ts[key] = target{address, credential}
		}
		if kind == "helper" {
			c.Min = metadata(r.Body, "minPluginVersion")
			c.Recommended = metadata(r.Body, "recommendedPluginVersion")
			if !semver.MatchString(c.Min) || !semver.MatchString(c.Recommended) {
				return Component{}, nil, errors.New("兼容元数据无效")
			}
		}
		if kind == "resources" {
			c.Audio = metadata(r.Body, "audioMode")
			if c.Audio != "on-demand" && c.Audio != "offline" && c.Audio != "bundled" {
				return Component{}, nil, errors.New("音频模式无效")
			}
		}
		return c, ts, nil
	}
	return Component{}, nil, errors.New("未找到完整稳定 Release")
}

// 同源刷新合并，调用方取消只退出自己的等待。锁只保护缓存与进行中的请求。
func (f *Feed) manifest(ctx context.Context, source string, force bool) (cached, error) {
	f.mu.Lock()
	old, has := f.cache[source]
	now := time.Now()
	if force {
		if now.Sub(f.refresh[source]) < time.Minute {
			force = false
		} else {
			f.refresh[source] = now
		}
	}
	if has && !force && now.Before(old.Until) {
		f.mu.Unlock()
		return old, nil
	}
	call := f.flights[source]
	if call == nil {
		call = &refreshCall{done: make(chan struct{})}
		f.flights[source] = call
		var previous cached
		for _, c := range f.cache {
			if c.Until.After(previous.Until) {
				previous = c
			}
		}
		go func() {
			work, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
			defer cancel()
			value, err := f.fetchManifest(work, source, previous)
			f.mu.Lock()
			defer f.mu.Unlock()
			if err == nil {
				f.cache[source] = value
			} else if has {
				value, err = old, nil
			}
			call.value, call.err = value, err
			delete(f.flights, source)
			close(call.done)
		}()
	}
	f.mu.Unlock()
	select {
	case <-ctx.Done():
		return cached{}, ctx.Err()
	case <-call.done:
		return call.value, call.err
	}
}
func (f *Feed) fetchManifest(ctx context.Context, source string, previous cached) (cached, error) {
	pr, err := f.releases(ctx, "github", f.cfg.PluginRepo, "plugin")
	var plugin Component
	var pt map[string]target
	if err == nil {
		plugin, pt, err = f.component(ctx, pr, "plugin", "github")
	}
	if err != nil {
		if previous.Manifest.Plugin.Version == "" {
			return cached{}, err
		}
		plugin = previous.Manifest.Plugin
		pt = map[string]target{}
		for k, t := range previous.Targets {
			if strings.HasPrefix(k, "plugin/") {
				pt[k] = t
			}
		}
	}
	sources := []string{source}
	if source == "" {
		sources = []string{"github"}
		if f.cfg.GiteeRepo != "" {
			sources = append(sources, "gitee")
		}
	}
	for _, s := range sources {
		repo := f.cfg.GithubRepo
		if s == "gitee" {
			repo = f.cfg.GiteeRepo
		}
		if repo == "" {
			continue
		}
		hr, e := f.releases(ctx, s, repo, "helper", "resources")
		if e != nil {
			continue
		}
		h, ht, e := f.component(ctx, hr, "helper", s)
		if e != nil {
			continue
		}
		r, rt, e := f.component(ctx, hr, "resources", s)
		if e != nil {
			continue
		}
		for k, v := range ht {
			pt[k] = v
		}
		for k, v := range rt {
			pt[k] = v
		}
		now := time.Now()
		out := cached{Manifest{1, now.UTC().Format(time.RFC3339), s, plugin, h, r}, pt, now.Add(time.Duration(f.cfg.CacheTTL) * time.Second)}
		slog.Info("清单刷新完成", "source", s)
		return out, nil
	}
	return cached{}, errors.New("上游暂不可用")
}
func jsonReply(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func (f *Feed) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// 清单和私有附件只在服务内缓存元数据；不要让前置 CDN 缓存鉴权响应。
	w.Header().Set("Cache-Control", "private, no-store")
	if r.Method != "GET" {
		jsonReply(w, 405, map[string]string{"error": "method_not_allowed"})
		return
	}
	if r.URL.Path == "/health" {
		jsonReply(w, 200, map[string]any{"ok": true, "service": "ielts-helper-feed", "time": time.Now().UTC().Format(time.RFC3339)})
		return
	}
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+f.cfg.AccessToken)) != 1 {
		jsonReply(w, 401, map[string]string{"error": "unauthorized"})
		return
	}
	source := r.URL.Query().Get("source")
	if source != "" && source != "github" && source != "gitee" {
		jsonReply(w, 400, map[string]string{"error": "invalid_source"})
		return
	}
	if r.URL.Path == "/manifest.json" {
		m, e := f.manifest(r.Context(), source, strings.Contains(r.Header.Get("Cache-Control"), "no-cache"))
		if e != nil {
			jsonReply(w, 502, map[string]string{"error": "upstream_unavailable"})
			return
		}
		jsonReply(w, 200, m.Manifest)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/download/") {
		f.download(w, r, source)
		return
	}
	jsonReply(w, 404, map[string]string{"error": "not_found"})
}
func (f *Feed) download(w http.ResponseWriter, r *http.Request, source string) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/download/"), "/")
	if len(parts) != 3 || (parts[0] != "plugin" && parts[0] != "helper" && parts[0] != "resources") || !semver.MatchString(parts[1]) || parts[2] == "" || strings.ContainsAny(parts[2], "/\\") || strings.Contains(parts[2], "..") {
		jsonReply(w, 400, map[string]string{"error": "invalid_path"})
		return
	}
	m, e := f.manifest(r.Context(), source, false)
	if e != nil {
		jsonReply(w, 502, map[string]string{"error": "upstream_unavailable"})
		return
	}
	t, ok := m.Targets[strings.Join(parts, "/")]
	if !ok {
		// 历史版本按精确 tag 查询，不依赖最新清单仍含旧附件。
		s := m.Manifest.Source
		repo := f.cfg.GithubRepo
		token := f.cfg.GithubToken
		base := "https://api.github.com/repos/"
		if s == "gitee" {
			repo = f.cfg.GiteeRepo
			token = f.cfg.GiteeToken
			base = "https://gitee.com/api/v5/repos/"
		}
		if parts[0] == "plugin" {
			s = "github"
			repo = f.cfg.PluginRepo
			token = ""
			base = "https://api.github.com/repos/"
		}
		tag := "v" + parts[1]
		if parts[0] == "resources" {
			tag = "resources-v" + parts[1]
		}
		if b, err := f.small(r.Context(), base+repo+"/releases/tags/"+tag, token); err == nil {
			var rel release
			if json.Unmarshal(b, &rel) == nil {
				_, ts, err := f.component(r.Context(), []release{rel}, parts[0], s)
				if err == nil {
					t, ok = ts[strings.Join(parts, "/")]
				}
			}
		}
	}
	if !ok {
		jsonReply(w, 404, map[string]string{"error": "asset_not_found"})
		return
	}
	u, e := url.Parse(t.URL)
	if e != nil || !allowed(u) {
		jsonReply(w, 502, map[string]string{"error": "upstream_unavailable"})
		return
	}
	req, _ := http.NewRequestWithContext(r.Context(), "GET", t.URL, nil)
	req.Header.Set("Accept", "application/octet-stream")
	if t.Token != "" {
		req.Header.Set("Authorization", "Bearer "+t.Token)
	}
	for _, h := range []string{"Range", "If-Range"} {
		if v := r.Header.Get(h); v != "" {
			req.Header.Set(h, v)
		}
	}
	resp, e := f.http.Do(req)
	if e != nil {
		jsonReply(w, 502, map[string]string{"error": "upstream_unavailable"})
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 && resp.StatusCode != 206 && resp.StatusCode != 416 {
		jsonReply(w, 502, map[string]string{"error": "upstream_unavailable"})
		return
	}
	for _, h := range []string{"Content-Length", "Content-Range", "Accept-Ranges", "ETag", "Last-Modified"} {
		if v := resp.Header.Get(h); v != "" {
			w.Header().Set(h, v)
		}
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.WriteHeader(resp.StatusCode)
	if _, e = io.Copy(w, resp.Body); e != nil {
		slog.Warn("附件流中断")
	}
}
func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stderr, nil)))
	c, e := loadConfig()
	if e != nil {
		slog.Error("配置无效")
		os.Exit(1)
	}
	srv := &http.Server{Addr: c.Listen, Handler: newFeed(c, client()), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	shutdownDone := make(chan struct{})
	go func() {
		defer close(shutdownDone)
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
	}()
	slog.Info("订阅服务启动")
	if e = srv.ListenAndServe(); e != nil && e != http.ErrServerClosed {
		slog.Error("监听失败")
		os.Exit(1)
	}
	<-shutdownDone
	slog.Info("订阅服务停止")
}
