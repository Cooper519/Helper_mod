"""使用临时配置和模拟上游验证凭据轮换，不访问真实服务。"""
import contextlib
import io
import os
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest import mock

import set_github_token as tool


class RotationTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.path = Path(temp.name, 'service.env')
        self.pat = 'github_pat_' + uuid.uuid4().hex
        self.old = b'# test\r\nGITHUB_REPO=demo/private\r\nGITHUB_TOKEN=\r\nACCESS_TOKEN=' + uuid.uuid4().hex.encode()
        self.path.write_bytes(self.old)
        self.out = io.StringIO()
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(contextlib.redirect_stdout(self.out))
        self.https = stack.enter_context(mock.patch.object(tool.http.client, 'HTTPSConnection'))
        self.restart = stack.enter_context(mock.patch.object(tool, 'restart_check'))

    def apply(self, status):
        self.https.return_value.getresponse.return_value.status = status
        tool.configure(str(self.path), self.pat)

    def test_success(self):
        self.apply(200)
        self.assertEqual(self.path.read_bytes(), self.old.replace(b'GITHUB_TOKEN=', b'GITHUB_TOKEN=' + self.pat.encode()))
        self.assertEqual(os.stat(str(self.path)).st_mode & 0o777, 0o600)
        self.https.assert_called_once_with('api.github.com', timeout=12)
        args, kwargs = self.https.return_value.request.call_args
        self.assertEqual(args, ('GET', '/repos/demo/private/releases?per_page=1'))
        self.assertEqual(kwargs['headers']['Authorization'], 'Bearer ' + self.pat)
        self.restart.assert_called_once_with()
        self.assertNotIn(self.pat, self.out.getvalue())

    def test_denied_or_redirected(self):
        for status in (401, 403, 404, 302):
            with self.subTest(status=status), self.assertRaisesRegex(RuntimeError, str(status)):
                self.apply(status)
            self.assertEqual(self.path.read_bytes(), self.old)
        self.restart.assert_not_called()
        self.assertEqual(self.https.return_value.request.call_count, 4)

    def test_failed_restart(self):
        self.restart.side_effect = [RuntimeError(), None]
        with self.assertRaisesRegex(RuntimeError, '旧配置已恢复'):
            self.apply(200)
        self.assertEqual(self.path.read_bytes(), self.old)
        self.assertEqual(self.restart.call_count, 2)
        self.assertEqual(list(self.path.parent.iterdir()), [self.path])

    def test_reject_ambiguous_config(self):
        self.path.write_bytes(self.old + b'\nGITHUB_TOKEN=\n')
        with self.assertRaisesRegex(RuntimeError, '唯一'):
            self.apply(200)
        self.https.assert_not_called()
        self.restart.assert_not_called()
