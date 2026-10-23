# cloudflare-ikuai

默认每轮从爱快已启用的 DNS 规则读取域名，对每个域名单独测试候选 IP 的 TLS 连接延迟，按该域名的平均延迟从低到高选择前 3 个，写入爱快 DNS 规则。不测试下载速度。

## 测速和写入流程

1. 登录爱快，读取当前已启用的 IPv4 DNS 规则（开启 IPv6 时也读取对应 IPv6 规则）。每轮重新读取，域名无需在容器里维护。可通过 `IK_DNS_RULE_IDS` 限制规则 ID；留空表示全部已启用规则。通配符、URL、IP 地址等无法作为 TLS 主机名的条目会跳过。
2. 先用自带的 CloudflareST 对候选做 HTTP 延迟初筛（默认 `https://cp.cloudflare.com/generate_204`，HEAD 请求，不下载响应正文）。首次扫描 `configs/ip.txt` 的完整范围，按每个 /24 随机取一个地址；后续保留最多 64 个候选，每轮另探索 32 个新网段地址。
3. 每个域名分别测试初筛前 24 个 IP，并加入该域名现有规则中的 IP。对每个组合新建 3 次 TLS 连接，使用目标域名 SNI，校验证书；连接总超时默认 2 秒。
4. 排除证书错误、超时过多和超出延迟上限的候选；按该域名的平均 TLS 连接耗时排序，取最前 3 个。默认失败率上限为 0.2，因此三次测试都成功才会入选。
5. 把该域名选出的 IP 按延迟升序写入本轮选中的爱快规则。不同域名可能选出不同 IP 和不同排序。保留备注、作用 IP 范围等字段；测速期间被停用、删除或改名的规则跳过，避免恢复用户已经取消的配置。
6. 只有 1–2 个候选通过时只写有效地址；没有通过的候选则保留原规则。爱快拒绝写入会明确报错，不记录为成功。完成写入后清理爱快 DNS 缓存。

这里的延迟是 **TCP 建连 + TLS 握手耗时**，不是 ICMP ping，也不代表 Tracker 返回业务响应的时间。前三名是本轮实际测试候选中的前三名，不代表穷举全部 Cloudflare 地址。没有额外的“必须比原始 DNS 快 15%”写入条件。

执行周期由 `CRON` 配置，默认 `0 * * * *`（每小时整点）。可使用标准五位 cron，例如 `*/5 * * * *` 表示每五分钟、`0 */2 * * *` 表示每两小时。启动时立即执行一轮；上一轮未结束则跳过重叠调度，不叠加测速任务。IPv6 开启后仍由 CloudflareST 对配置的 IPv6 范围采样，每轮可能更久。

## 本地构建和检查

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
```

产物位于 `dist/`，测速程序仅提供 Linux 和 Windows 版本。macOS 可以编辑、测试和构建源码，运行完整服务请使用 Linux Docker。

## 拉取已发布镜像

```sh
docker pull ghcr.io/gctts/cloudflare-ikuai:latest
```

镜像由 main 分支的 GitHub Actions 运行测试、源码构建和容器检查后发布。每次 main 更新会自动发布 latest 和 `sha-<完整提交哈希>` 两个标签。当前内置测速工具为 Linux amd64，仅发布对应架构镜像。

仓库已提供可直接拉取镜像的 `compose.yaml`；账号密码和 CRON 通过 `.env` 调整，持久化配置位于 `./cloudflare-ikuai/configs`。首次发布后，GHCR 包需要设为 Public，才能免登录拉取。

## Docker 构建和运行

Dockerfile 会从本项目源码自动编译，无需提前准备 dist 或挂载修改后的 index.js。

```sh
docker build -t cloudflare-ikuai:local .
```

Compose 示例（`./cloudflare-ikuai/configs` 为持久化配置目录）：

```yaml
services:
  cloudflare-ikuai:
    image: ghcr.io/gctts/cloudflare-ikuai:latest
    container_name: Cloudflare-Ikuai
    restart: unless-stopped
    network_mode: host
    environment:
      TZ: Asia/Shanghai
      DOMAIN_SOURCE: ${DOMAIN_SOURCE:-ikuai}
      IK_DNS_RULE_IDS: "${IK_DNS_RULE_IDS:-}"
      CRON: "${CRON:-0 * * * *}"
      ROUTER_IP: ${ROUTER_IP}
      ROUTER_PORT: ${ROUTER_PORT:-80}
      ROUTER_USERNAME: ${ROUTER_USERNAME}
      ROUTER_PASSWORD: ${ROUTER_PASSWORD}
    volumes:
      - ./cloudflare-ikuai/configs:/app/configs
    mem_limit: 512m
```

项目已提供 `compose.yaml` 和 `.env.example`。复制 `.env.example` 为 `.env`，填写实际账号密码及网络模式后，可执行 `docker compose pull && docker compose up -d`。`.env` 已加入 gitignore。环境变量优先于配置文件。`configs/service.env` 只保留配置模板，不要把实际密码提交进 Git。

测速结果取决于网络出口。若 qB 被爱快分流到另一条 WAN，测速容器也应走同一出口：可以在部署时将 `network_mode` 改成 `container:qbittorrent-8088`。qB 容器重建后，需重新创建本服务以绑定新容器的网络命名空间。

## 配置和结果

- `DOMAIN_SOURCE=ikuai`（默认）：直接从爱快读取已启用规则。新增域名时在爱快添加并启用对应 DNS 规则即可，下轮自动测试；改名和停用也会自动跟随，无需修改容器列表或重启。新增规则的解析地址先填该域名当前可用的地址。
- `IK_DNS_RULE_IDS`：可选，留空表示全部已启用规则，支持 `1`、`1-12`、`1,2,4-9,10`。配置指定 ID 后，爱快新增规则或改名导致 ID 变化时，应相应调整此范围。
- `DOMAIN_SOURCE=file`：兼容旧的 `configs/domain.txt` 模式，每行一个域名；仅此模式读取该文件，并会新增缺失的规则、启用有有效结果的规则。默认爱快来源不读取此文件。
- `configs/service.env`：参数模板；修改后重启生效。关键参数为 `SELECT_NUM=3`、`DISABLE_DOWNLOAD=true`、`CRON=0 * * * *`。
- `configs/ip.txt` / `configs/ipv6.txt`：完整候选范围，不会被测速结果覆盖。
- `configs/runtime/candidates-v4.json`：保留的初筛候选池。
- `configs/runtime/last-run-v4.json` / `last-run-v6.json`：本轮域名来源、规则 ID、逐域名的所有样本、失败原因、排序、最终选中 IP 和爱快写入状态；通过临时文件原子替换。

`DOMAIN_CANDIDATE_NUM` 控制每域名的候选数量，`DOMAIN_TESTS` 控制重复次数，`DOMAIN_TIMEOUT_MS` 控制超时，`DOMAIN_CONCURRENCY` 控制全部域名共享的连接并发上限。更多参数见 `configs/service.env` 注释。

## 上游项目

- https://github.com/elevenx5566/cloudflare-ikuai
- https://github.com/XIU2/CloudflareSpeedTest
- https://github.com/yuxiaolejs/ikuai
