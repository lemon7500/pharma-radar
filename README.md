# Pharma Radar

面向药学学生与研究者的研究阅读站：发现资料，判断证据范围，找到原文，持续追踪研究方向。v2 采用桌面侧栏、原始发表时间线及独立组合筛选，详见 [升级与运维说明](docs/pharma-radar-v2.md)。

小范围读者试用的 [任务说明](docs/reader-trial.md) 与 [空白反馈表](docs/reader-trial-feedback.csv) 已准备；实际试用和独立精选标注仍需分别完成。

内容推荐与纠错方式见 [编辑判断与可靠性](docs/editorial-quality.md)。精选用于帮助发现值得阅读的资料；研究结论、材料范围和编辑判断分别说明。

本项目基于 [AIHOT](https://github.com/KKKKhazix/AIHOT) 定制，保留上游 MIT 许可证。网页、后台、采集、模型筛选、事件归组、日报、RSS、公开 API 和 MCP 共用一套公开内容读取层。

## 免费部署

采用 **Render Free Web Service + Supabase Free + GitHub 公开仓库 Actions**。网页和 API 在一个 Render 服务内运行；采集与模型处理按小时在 Actions 中有限运行，任务状态保存在 PostgreSQL。无需自备域名，使用 Render HTTPS 地址。网站无访问时会休眠，定时执行可能延迟。模型 API 的用量费用另计。

完整配置、配额和交付步骤：[部署方案](docs/pharma-deployment.md)。模板入口：[render.yaml](render.yaml)、[小时采集](.github/workflows/pharma-collect.yml)、[私有加密备份](.github/workflows/pharma-backup.yml)。密钥通过平台环境变量和 Secrets 设置，绝不提交源码。

## 定制内容

- 中药、天然产物和 AI 制药的主题关键词分别管理；含药理、制剂、临床、监管、论文与工具。
- 首批来源为两种 Nature 期刊 RSS 和三组 Europe PMC 检索，展示摘要及原文链接。
- 药学提示词区分计算、细胞、动物、临床和获批阶段。初始评分门槛沿用框架默认值，尚未用药学标注样本校准。
- Supabase 私有存储保存上传原始文件，Render 本地磁盘只作缓存；匿名客户端不可访问后台数据库表。
- 默认关闭 X/微信付费采集、Jina、向量服务、飞书推送和模型排行榜。

配置入口：[站名](industry/site.ts)、[分类](industry/taxonomy.ts)、[主题关键词](industry/topics.json)、[采集查询和信源](industry/sources.json)、[写作与筛选提示词](industry/prompts)。

## 本地运行与验证

需要 Node.js 24.11+、PostgreSQL 17。按 [原框架部署文档](docs/deploy.md) 准备数据库和本地环境，测试数据库名称必须以 `_test` 或 `_ci` 结尾。不要使用真实线上数据库运行测试。

```sh
npm ci
node --env-file=.env scripts/migrate.ts
node --env-file=.env scripts/seed.ts
npm run build -w @aihot/web
node --env-file=.env deploy/start-web.mjs
```

测试入口为 `npm run typecheck`、`npm test`、`node --test apps/web/tests/*.test.ts` 和 `node scripts/smoke.ts --base http://localhost:3000`。模型测试仅连接本地 HTTP 桩；POSIX 信号测试由 Linux CI 执行。

[使用规则](industry/pages/terms.md) 和 [隐私说明](industry/pages/privacy.md) 已经运营者 Lemon 确认，随站点正式开放生效。

上游说明保存在 [README.upstream.md](README.upstream.md)，软件许可见 [LICENSE](LICENSE)。资讯原文的版权与许可属于各来源。
