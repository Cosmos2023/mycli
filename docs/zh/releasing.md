<a id="releasing-mycli"></a>

# 发布 mycli

[English](../releasing.md) | **简体中文** | [中文目录](README.md)

mycli 对 16 个组件统一版本，但只发布 `@cosmos2023/mycli` 和六个可选 ripgrep 平台包。其他九个运行时工作区为私有包，打包时内置到应用的 `dist/node_modules`。工作区根目录不发布。

<a id="one-time-repository-setup"></a>

## 仓库首次设置

1. 确保 npm 账号拥有 `@cosmos2023` scope，并具有全部七个公开包的发布权限。
2. 创建名为 `npm` 的受保护 GitHub environment，要求审查者批准，避免仅推送版本标签就触发发布。
3. 为全部七个公开包配置 `.github/workflows/release.yml` 的 npm Trusted Publishing。工作流只在受保护发布任务中授予 `id-token: write` 和 `contents: write`。
4. 首次发布时，尚不存在的包可能需要 environment secret `NPM_TOKEN` 中的细粒度 npm token。建立包并配置 Trusted Publishing 后移除该 secret。显式 token 优先于 OIDC。

不要提交 npm token，也不要将其写入项目 `.npmrc`。

<a id="prepare-a-version"></a>

## 准备版本

从干净且最新的 `main` checkout 开始，不从功能 worktree 发布。

```bash
npm ci
npm run release:version -- 0.2.0
npm run release:verify
npm run release:compatibility
npm run contracts:check
npm run lint
npm run test:ci
npm run typecheck
npm run smoke:m8
npm run smoke:package -- --all-platforms
npm run smoke:release-compatibility -- --evidence release-evidence/local.json
```

有凭据时，在确定性检查通过后运行主动启用的精选 provider 冒烟测试，只保留脱敏证据：

```bash
npm run smoke:providers -- --dry-run
npm run smoke:providers -- --evidence release-evidence/providers-live.json
```

没有凭据的行保持 `skipped`，只有 `passed` 行可称为经过真实服务验证。单 provider 启动级密钥用法和证据字段见 [providers.md](providers.md)。

`release:version` 更新所有统一版本的清单、内部依赖声明和工作区锁文件。以下情况会让 `release:verify` 失败：根目录可发布、公开包为私有、内置工作区为公开、应用依赖闭包不完整、版本不一致或发布权限无效。

创建标签前审查并提交版本修改。也可预览本地包发布：

```bash
npm run release:dry-run
```

预览构建所有工作区，并对全部七个公开包执行 `npm publish --dry-run`，不会发布、创建标签或 GitHub Release。完整 CI 包冒烟检查还会加入由 Windows 发布任务编译的沙箱辅助程序。发布命令使用已忽略的工作区缓存 `.npm-cache/release`，避免用户 npm 缓存损坏或所有者不同导致结果依赖机器环境。

<a id="publish"></a>

## 发布

创建与清单版本匹配的附注标签并推送：

```bash
git tag -a v0.2.0 -m "mycli v0.2.0"
git push origin v0.2.0
```

独立的 `release-compatibility` 流程在 macOS、Ubuntu 和 Windows 上验证已安装产物。依赖注册表的前身版本流程仅在明确的注册表/网络基础设施故障时以 `77` 退出或记录 `blocked_external`；候选产品失败仍是硬失败。标签发布会严格重复这一流程，不豁免外部阻塞。

随后发布流程会：

1. 在 Windows 上构建 Windows 沙箱辅助程序。
2. 确认标签提交属于 `main`，验证标签和统一元数据。
3. 运行契约、lint、分类测试、类型检查、兼容性策略、M8 冒烟、打包产物和真实前身版本升级/降级检查。
4. 先发布六个平台包，再发布应用包。
5. 稳定版本使用 `latest`，预发布版本使用 `next`。
6. 仅在 npm 发布成功后创建 GitHub Release。

发布器固定使用公开 npm 注册表，并附带 provenance。真正发布同时要求 `release:publish` 内的 `--publish` 模式，以及与应用清单匹配的明确 `--confirm X.Y.Z`。重跑时先检查每个包的精确版本，跳过已发布版本，从首个缺失包继续。认证、连接和其他非 404 注册表错误会停止发布，不会被当作包不存在。

<a id="failed-or-partial-release"></a>

## 发布失败或部分完成

不要删除或替换 npm 已接受的版本。修复流程或基础设施问题后，重跑失败的 GitHub Actions 任务；有序发布器会安全跳过已完成的包。

如果没有任何包发布，可以删除错误标签、修正发布提交并重新创建标签。只要已有包发布，就保留不可变版本并完成同一次发布；代码修正使用新的补丁版本。用户回退通过安装先前应用版本完成：

```bash
npm install -g @cosmos2023/mycli@0.1.0
```

兼容范围、包名迁移、配置回退和会话 schema 限制见 [compatibility.md](compatibility.md) 和 [upgrading.md](upgrading.md)。发布人员必须在创建标签前更新 [../CHANGELOG.md](CHANGELOG.md) 和 [release-notes.md](release-notes.md)。
