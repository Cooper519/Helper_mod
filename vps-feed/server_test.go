package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type roundFunc func(*http.Request) (*http.Response, error)

func (fn roundFunc) RoundTrip(r *http.Request) (*http.Response, error) { return fn(r) }
func randomToken() string                                              { b := make([]byte, 32); _, _ = rand.Read(b); return hex.EncodeToString(b) }

// 仅测试替换网络路由，生产 URL、鉴权、清单及流式 handler 原样执行。
func fixture(t *testing.T, dir string) (*Feed, *atomic.Int64) {
	t.Helper()
	token := randomToken()
	calls := &atomic.Int64{}
	files := map[string][]byte{}
	if dir != "" {
		entries, e := os.ReadDir(dir)
		if e != nil {
			t.Fatal(e)
		}
		for _, entry := range entries {
			if !entry.IsDir() {
				b, e := os.ReadFile(filepath.Join(dir, entry.Name()))
				if e != nil {
					t.Fatal(e)
				}
				files[entry.Name()] = b
			}
		}
	} else {
		for _, n := range []string{"main.js", "manifest.json", "styles.css", "ielts-helper-4.0.0.zip", "ielts-helper-resources-1.2.3.zip"} {
			files[n] = []byte("隔离附件-" + n)
		}
	}
	sums := ""
	declared := map[string]string{}
	for _, line := range strings.Split(string(files["checksums.txt"]), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 {
			declared[strings.TrimPrefix(fields[1], "*")] = fields[0]
		}
	}
	for n, b := range files {
		if n != "checksums.txt" && n != "SHA256SUMS" {
			if expected, ok := declared[n]; ok {
				sums += expected + "  " + n + "\n"
				continue
			}
			h := sha256.Sum256(b)
			sums += fmt.Sprintf("%x  %s\n", h, n)
		}
	}
	files["checksums.txt"] = []byte(sums)
	mk := func(tag, body string, names []string) release {
		r := release{Tag: tag, Body: body, Published: "2026-11-23T00:00:00Z"}
		for i, n := range append(names, "checksums.txt") {
			r.Assets = append(r.Assets, asset{Name: n, ID: int64(i + 1), Size: int64(len(files[n])), URL: "https://api.github.com/assets/" + n, Download: "https://gitee.com/assets/" + n})
		}
		return r
	}
	plugin := mk("v2.0.0", "插件说明", []string{"main.js", "manifest.json", "styles.css"})
	if dir != "" {
		var info struct {
			Version string `json:"version"`
		}
		if json.Unmarshal(files["manifest.json"], &info) != nil || !semver.MatchString(info.Version) {
			t.Fatal("插件 manifest.json 缺少合法版本")
		}
		plugin.Tag = "v" + info.Version
	}
	var helperName, resourceName string
	for n := range files {
		if strings.HasPrefix(n, "ielts-helper-resources-") && strings.HasSuffix(n, ".zip") {
			resourceName = n
		} else if strings.HasPrefix(n, "ielts-helper-") && strings.HasSuffix(n, ".zip") {
			helperName = n
		}
	}
	if helperName == "" || resourceName == "" {
		t.Fatal("临时目录缺少程序或资源 ZIP")
	}
	hv := strings.TrimSuffix(strings.TrimPrefix(helperName, "ielts-helper-"), ".zip")
	rv := strings.TrimSuffix(strings.TrimPrefix(resourceName, "ielts-helper-resources-"), ".zip")
	hr := []release{mk("v"+hv, "minPluginVersion: 2.0.0\nrecommendedPluginVersion: 2.0.0", []string{helperName}), mk("resources-v"+rv, "audioMode: on-demand", []string{resourceName})}
	// 有真实轻量构建产物时直接采用发布者正文与校验和，不用测试默认值替换。
	if notes := files["release-notes-helper-"+hv+".md"]; len(notes) > 0 {
		hr[0].Body = string(notes)
	}
	if notes := files["release-notes-resources-"+rv+".md"]; len(notes) > 0 {
		hr[1].Body = string(notes)
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if strings.Contains(r.URL.Path, "/releases/tags/") {
			tag := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
			for _, rel := range append(hr, plugin) {
				if rel.Tag == tag {
					_ = json.NewEncoder(w).Encode(rel)
					return
				}
			}
			http.NotFound(w, r)
			return
		}
		if strings.Contains(r.URL.Path, "/releases") {
			if strings.Contains(r.URL.Path, "/public/") {
				_ = json.NewEncoder(w).Encode([]release{plugin})
			} else {
				_ = json.NewEncoder(w).Encode(hr)
			}
			return
		}
		name := strings.TrimPrefix(r.URL.Path, "/assets/")
		b, ok := files[name]
		if !ok {
			http.NotFound(w, r)
			return
		}
		http.ServeContent(w, r, name, time.Time{}, strings.NewReader(string(b)))
	}))
	t.Cleanup(upstream.Close)
	base, _ := url.Parse(upstream.URL)
	h := client()
	h.Transport = roundFunc(func(r *http.Request) (*http.Response, error) {
		copy := r.Clone(r.Context())
		u := *r.URL
		u.Scheme = base.Scheme
		u.Host = base.Host
		copy.URL = &u
		return http.DefaultTransport.RoundTrip(copy)
	})
	return newFeed(Config{AccessToken: token, PluginRepo: "public/plugin", GithubRepo: "private/helper", GiteeRepo: "private/helper", GithubToken: randomToken(), GiteeToken: randomToken(), CacheTTL: 300}, h), calls
}
func request(f *Feed, path, token string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", path, nil)
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	f.ServeHTTP(w, r)
	return w
}
func TestManifestAuthCache(t *testing.T) {
	f, calls := fixture(t, "")
	for _, token := range []string{"", randomToken()} {
		if w := request(f, "/manifest.json", token); w.Code != 401 {
			t.Fatal(w.Code)
		}
	}
	if w := request(f, "/manifest.json?access_token="+randomToken(), ""); w.Code != 401 {
		t.Fatal(w.Code)
	}
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if w := request(f, "/manifest.json", f.cfg.AccessToken); w.Code != 200 {
				t.Error(w.Body.String())
			}
		}()
	}
	wg.Wait()
	if calls.Load() != 5 {
		t.Fatal("未合并上游请求", calls.Load())
	}
	w := request(f, "/manifest.json?source=gitee", f.cfg.AccessToken)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"source":"gitee"`) {
		t.Fatal(w.Body.String())
	}
	var mirror Manifest
	if json.Unmarshal(w.Body.Bytes(), &mirror) != nil || !strings.HasSuffix(mirror.Helper.Asset.URL, "?source=gitee") {
		t.Fatal("镜像下载地址未保留来源")
	}
	if d := request(f, mirror.Helper.Asset.URL, f.cfg.AccessToken); d.Code != 200 {
		t.Fatal("镜像下载失败", d.Code)
	}
}
func TestDownloadAndPaths(t *testing.T) {
	f, _ := fixture(t, "")
	for _, path := range []string{"/download/no/1.0.0/a", "/download/helper/v1/a", "/download/helper/1.0.0/..x", "/download/helper/1.0.0/a%5Cb"} {
		if w := request(f, path, f.cfg.AccessToken); w.Code != 400 {
			t.Fatal(path, w.Code)
		}
	}
	path := "/download/helper/4.0.0/ielts-helper-4.0.0.zip"
	w := request(f, path, f.cfg.AccessToken)
	if w.Code != 200 || w.Body.String() != "隔离附件-ielts-helper-4.0.0.zip" {
		t.Fatal(w.Code, w.Body.String())
	}
	r := httptest.NewRequest("GET", path, nil)
	r.Header.Set("Authorization", "Bearer "+f.cfg.AccessToken)
	r.Header.Set("Range", "bytes=0-3")
	w = httptest.NewRecorder()
	f.ServeHTTP(w, r)
	if w.Code != 206 || w.Body.Len() != 4 || w.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatal(w.Code, w.Body.Len())
	}
}
func TestRedirectSecurity(t *testing.T) {
	secret := randomToken()
	if assetToken("https://foruda.gitee.com/a", "github", "helper", secret) != "" || assetToken("https://api.github.com/a", "github", "plugin", secret) != "" || assetToken("https://api.github.com/a", "github", "helper", secret) != secret {
		t.Fatal("初始附件站点或公开插件凭据范围错误")
	}
	for _, raw := range []string{"http://github.com/a", "https://evil.example/a", "https://github.com.evil/a", "https://github.com:443/a", "https://user@github.com/a"} {
		u, _ := url.Parse(raw)
		r := &http.Request{URL: u, Header: make(http.Header)}
		if redirect(r, nil) == nil {
			t.Fatal(raw)
		}
	}
	u, _ := url.Parse("https://release-assets.githubusercontent.com/a")
	v, _ := url.Parse("https://api.github.com/a")
	r := &http.Request{URL: u, Header: http.Header{"Authorization": []string{randomToken()}}}
	if redirect(r, []*http.Request{{URL: v}}) != nil || r.Header.Get("Authorization") != "" {
		t.Fatal("跨主机凭据未剥离")
	}
}
func TestExactTagDownload(t *testing.T) {
	f, _ := fixture(t, "")
	_, _ = f.manifest(context.Background(), "", false)
	m := f.cache[""]
	delete(m.Targets, "helper/4.0.0/ielts-helper-4.0.0.zip")
	w := request(f, "/download/helper/4.0.0/ielts-helper-4.0.0.zip", f.cfg.AccessToken)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
}
func TestFallbackAndStale(t *testing.T) {
	f, _ := fixture(t, "")
	transport := f.http.Transport
	failGithub := true
	f.http.Transport = roundFunc(func(r *http.Request) (*http.Response, error) {
		if failGithub && strings.Contains(r.URL.Path, "private/helper") && r.URL.Host == "api.github.com" {
			return nil, fmt.Errorf("模拟上游失败")
		}
		return transport.RoundTrip(r)
	})
	m, e := f.manifest(context.Background(), "", false)
	if e != nil || m.Manifest.Source != "gitee" {
		t.Fatal(e, m.Manifest.Source)
	}
	f.http.Transport = roundFunc(func(*http.Request) (*http.Response, error) { return nil, fmt.Errorf("模拟全部失败") })
	m, e = f.manifest(context.Background(), "", true)
	if e != nil || m.Manifest.Source != "gitee" {
		t.Fatal("旧缓存不可用", e)
	}
}
func TestForceRefreshLimit(t *testing.T) {
	f, calls := fixture(t, "")
	_, _ = f.manifest(context.Background(), "", false)
	_, _ = f.manifest(context.Background(), "", true)
	n := calls.Load()
	_, _ = f.manifest(context.Background(), "", true)
	if calls.Load() != n {
		t.Fatal("强刷未限流")
	}
}

// 发布通知必须刷新插件下次普通 GET 读取的那份缓存，而不是仅刷新 ?source=github。
func TestPublishedReleaseWarmsDefaultManifest(t *testing.T) {
	f, _ := fixture(t, "")
	read := func(force bool) Manifest {
		t.Helper()
		r := httptest.NewRequest("GET", "/manifest.json", nil)
		r.Header.Set("Authorization", "Bearer "+f.cfg.AccessToken)
		if force {
			r.Header.Set("Cache-Control", "no-cache")
		}
		w := httptest.NewRecorder()
		f.ServeHTTP(w, r)
		var m Manifest
		if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &m) != nil {
			t.Fatalf("清单不可用：HTTP %d", w.Code)
		}
		return m
	}
	if got := read(false).Helper.Tag; got != "v4.0.0" {
		t.Fatalf("初始程序 tag = %q", got)
	}
	// 将模拟上游切换为新版；已有 VPS 实例和客户端默认缓存都不重建。
	dir := t.TempDir()
	for name, data := range map[string]string{
		"manifest.json": `{"version":"2.0.0"}`, "main.js": "// 插件", "styles.css": "/* 插件 */",
		"ielts-helper-4.0.1.zip": "程序附件", "ielts-helper-resources-1.2.3.zip": "资源附件",
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
	}
	upstream, calls := fixture(t, dir)
	f.http = upstream.http
	if got := read(false).Helper.Tag; got != "v4.0.0" || calls.Load() != 0 {
		t.Fatal("发布后、通知前应仍命中旧缓存")
	}
	if got := read(true).Helper.Tag; got != "v4.0.1" {
		t.Fatalf("通知后的程序 tag = %q", got)
	}
	n := calls.Load()
	if got := read(false).Helper.Tag; got != "v4.0.1" || calls.Load() != n {
		t.Fatal("客户端下次检查没有直接命中已刷新的新版")
	}
}
func TestGiteeMissingSize(t *testing.T) {
	f, _ := fixture(t, "")
	var rel release
	b := []byte(`{"tag_name":"v4.0.0","created_at":"2026-11-23T00:00:00Z","body":"minPluginVersion: 2.0.0\nrecommendedPluginVersion: 2.0.0","assets":[{"name":"ielts-helper-4.0.0.zip","browser_download_url":"https://gitee.com/assets/ielts-helper-4.0.0.zip"},{"name":"checksums.txt","browser_download_url":"https://gitee.com/assets/checksums.txt"}]}`)
	if e := json.Unmarshal(b, &rel); e != nil {
		t.Fatal(e)
	}
	if rel.Assets[0].Size != -1 {
		t.Fatal("缺失大小被解释为零")
	}
	c, _, e := f.component(context.Background(), []release{rel}, "helper", "gitee")
	if e != nil || c.Asset.Size <= 0 || c.Published != rel.Created {
		t.Fatal(c, e)
	}
}
func TestMissingChecksumFails(t *testing.T) {
	f, _ := fixture(t, "")
	r := release{Tag: "v1.0.0", Assets: []asset{{Name: "main.js"}, {Name: "manifest.json"}, {Name: "styles.css"}}}
	if _, _, e := f.component(context.Background(), []release{r}, "plugin", "github"); e == nil {
		t.Fatal("缺失校验清单未拒绝")
	}
}
func TestAudioModes(t *testing.T) {
	f, _ := fixture(t, "")
	rs, e := f.releases(context.Background(), "github", f.cfg.GithubRepo, "helper", "resources")
	if e != nil {
		t.Fatal(e)
	}
	for _, mode := range []string{"on-demand", "offline", "bundled"} {
		rs[1].Body = "audioMode: " + mode
		c, _, e := f.component(context.Background(), rs, "resources", "github")
		if e != nil || c.Audio != mode {
			t.Fatal(mode, c.Audio, e)
		}
	}
}

// 程序可频繁发布；独立资源包不会因为不在第一页而消失。
func TestResourceBeyondFirstPage(t *testing.T) {
	f, _ := fixture(t, "")
	original := f.http.Transport
	f.http.Transport = roundFunc(func(r *http.Request) (*http.Response, error) {
		if strings.Contains(r.URL.Path, "private/helper/releases") && r.URL.Query().Get("page") == "1" {
			rows := make([]release, 100)
			for i := range rows {
				rows[i].Tag = fmt.Sprintf("internal-%d", i)
			}
			b, _ := json.Marshal(rows)
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(string(b))), Header: make(http.Header)}, nil
		}
		return original.RoundTrip(r)
	})
	m, e := f.manifest(context.Background(), "github", false)
	if e != nil || m.Manifest.Resources.Version != "1.2.3" {
		t.Fatal("未找到后续页的稳定资源", e)
	}
}

// GitHub 不可用时允许复用已知插件，但不能将旧版私有附件当作镜像结果。
func TestOfflineGithubStillUpdatesGitee(t *testing.T) {
	f, _ := fixture(t, "")
	ctx := context.Background()
	if _, err := f.manifest(ctx, "github", false); err != nil {
		t.Fatal(err)
	}
	orig := f.http.Transport
	f.http.Transport = roundFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host == "api.github.com" {
			return nil, fmt.Errorf("公开仓离线")
		}
		return orig.RoundTrip(r)
	})
	m, err := f.manifest(ctx, "gitee", false)
	if err != nil || m.Manifest.Source != "gitee" || m.Manifest.Plugin.Version != "2.0.0" || !strings.Contains(m.Targets["helper/4.0.0/ielts-helper-4.0.0.zip"].URL, "gitee.com") {
		t.Fatalf("未复用插件并取得镜像更新：%v", err)
	}
}
func TestRefreshCancellationDoesNotBlockOtherSources(t *testing.T) {
	f, _ := fixture(t, "")
	orig := f.http.Transport
	started := make(chan struct{})
	resume := make(chan struct{})
	var once sync.Once
	f.http.Transport = roundFunc(func(r *http.Request) (*http.Response, error) {
		if strings.Contains(r.URL.Path, "private/helper/releases") && r.URL.Host == "api.github.com" {
			once.Do(func() { close(started) })
			select {
			case <-resume:
			case <-r.Context().Done():
				return nil, r.Context().Err()
			}
		}
		return orig.RoundTrip(r)
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { _, e := f.manifest(ctx, "github", false); done <- e }()
	<-started
	independent, stop := context.WithTimeout(context.Background(), 2*time.Second)
	defer stop()
	_, e := f.manifest(independent, "gitee", false)
	cancel()
	first := <-done
	close(resume)
	if e != nil || first != context.Canceled {
		t.Fatalf("独立更新或取消失败：%v / %v", e, first)
	}
	if _, e = f.manifest(context.Background(), "github", false); e != nil {
		t.Fatalf("共享刷新被取消：%v", e)
	}
}
func TestSelectHighestCompleteRelease(t *testing.T) {
	f, _ := fixture(t, "")
	rows, e := f.releases(context.Background(), "github", f.cfg.PluginRepo, "plugin")
	if e != nil {
		t.Fatal(e)
	}
	old := rows[0]
	old.Tag = "v2.9.0"
	highest := old
	highest.Tag = "v2.10.0"
	bad := old
	bad.Tag = "v3.0.0"
	bad.Assets = old.Assets[:3]
	c, _, err := f.component(context.Background(), []release{old, bad, highest}, "plugin", "github")
	if err != nil || c.Version != "2.10.0" {
		t.Fatal(c.Version, err)
	}
	h := strings.Repeat("a", 64)
	sums := checksums([]byte(h + "  *with space.zip\r\n"))
	if sums["with space.zip"] != h {
		t.Fatal("未保留文件名空格")
	}
}

type countWriter struct {
	header http.Header
	n      int64
	status int
}

func (w *countWriter) Header() http.Header         { return w.header }
func (w *countWriter) WriteHeader(s int)           { w.status = s }
func (w *countWriter) Write(b []byte) (int, error) { w.n += int64(len(b)); return len(b), nil }

type zeroReader struct{}

func (zeroReader) Read(b []byte) (int, error) {
	if len(b) > 64*1024 {
		return 0, fmt.Errorf("读取缓冲超过流式上限")
	}
	clear(b)
	return len(b), nil
}
func TestLargeStream(t *testing.T) {
	f, _ := fixture(t, "")
	_, _ = f.manifest(context.Background(), "", false)
	const size = 350 * 1024 * 1024
	f.http.Transport = roundFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Length": []string{fmt.Sprint(size)}}, Body: io.NopCloser(io.LimitReader(zeroReader{}, size))}, nil
	})
	w := &countWriter{header: make(http.Header)}
	r := httptest.NewRequest("GET", "/download/resources/1.2.3/ielts-helper-resources-1.2.3.zip", nil)
	r.Header.Set("Authorization", "Bearer "+f.cfg.AccessToken)
	f.ServeHTTP(w, r)
	if w.n != size || w.status != 200 {
		t.Fatal(w.n, w.status)
	}
}

// TestIsolatedFeed 是跨端联调的测试专用入口，不进入生产二进制。
func TestIsolatedFeed(t *testing.T) {
	dir := os.Getenv("FEED_TEST_ASSETS")
	if dir == "" {
		t.Skip("未启用隔离联调")
	}
	ready, token := os.Getenv("FEED_TEST_READY"), os.Getenv("FEED_TEST_TOKEN")
	if ready == "" || token == "" {
		t.Fatal("缺少就绪文件或临时密钥")
	}
	f, _ := fixture(t, dir)
	f.cfg.AccessToken = token
	s := httptest.NewTLSServer(f)
	defer s.Close()
	cert := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: s.Certificate().Raw})
	if e := os.WriteFile(ready+".pem", cert, 0600); e != nil {
		t.Fatal(e)
	}
	defer os.Remove(ready + ".pem")
	b, _ := json.Marshal(map[string]string{"url": s.URL})
	if e := os.WriteFile(ready, b, 0600); e != nil {
		t.Fatal(e)
	}
	defer os.Remove(ready)
	for {
		if _, e := os.Stat(ready + ".stop"); e == nil {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
}
