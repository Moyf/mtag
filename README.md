# MTAG 网页发布版 v0.3.3

这是普通浏览器版。请通过本机静态服务器或 HTTPS 打开，不要直接双击 `index.html`，否则浏览器可能阻止 ES module 和本地资源加载。

推荐使用最新版 Chrome 或 Edge：

```bash
npx --yes serve . --listen 8420 --no-clipboard
```

然后打开 `http://127.0.0.1:8420/`。素材和导出均在浏览器本机处理，不会上传。
