# 中国大陆部署

- 分支：`china`
- 中文站点：`https://docflow.livegrc.chat`
- 英文站点：`https://docflow-web-woad.vercel.app`
- 启动：复制 `.env.china.example` 为 `.env`，填写随机密码和模型 API 密钥后运行 `docker compose -f compose.china.yml up -d --build`

中文部署使用独立 PostgreSQL 和私有文档数据卷，不依赖 Vercel Blob。文档只有通过租户鉴权后才由 API 流式返回。数据库与文档存储都没有映射到宿主机公网端口。反向代理需要将 `/api/*` 和 `/docs-assets/*` 转发到 `docflow-cn-api:8080`，其余请求转发到 `docflow-cn-web:3000`。
