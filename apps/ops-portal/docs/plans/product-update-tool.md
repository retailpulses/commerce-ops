# Product update tool — Canonical Plan v3

状态：用户已授权实施与部署；v3 为当前 canonical plan，取代 v2，采纳 codex-b 两项 P2。已部署；owner 原值写回与回读通过，Access 已登录页面验收待完成。日期：2026-09-08（JST）。

用户确认：去掉 OrderMgmt 中转；后续继续增加产品主数据业务值工具。认证要求按上下文解释为复用现有 Cloudflare Access，operator 无需额外登录、账户或 token。

## 1. 目标与完成标准

Operator 从 `https://ops.homesbliss.net/tools` 打开 **Product update tool**，输入完整 Item Code，读取已有产品，查看只读的当前 Effective Restock Date，设置或清除与 Order Portal 相同的三个手动字段，并在保存后回读确认。查询不依赖订单、店铺刊登、库存或预售状态。

“任何已有产品”指产品主数据中可按 Item Code 唯一定位的 variant；重复身份或缺失商业数据属于数据异常，必须明确报错，不能自动创建或任选一条更新。

## 2. 首版范围

| 页面/动作               | 约定                                                                         |
| ----------------------- | ---------------------------------------------------------------------------- |
| `/tools`                | 工具目录，展示 Product update tool 卡片；Ops 导航增加 Tools 入口             |
| `/tools/product-update` | 独立查询与编辑页面，刷新或直接打开仍可用                                     |
| Search                  | 完整 Item Code 精确查询，去除首尾空格、大小写不敏感；按 Enter 或 Search 发起 |
| 产品识别                | 显示 owner 返回的规范 Item Code；首版不依赖新增产品名称/图片接口             |
| 编辑                    | 显示三个手动值及只读 `effective_cost_price`、`effective_restock_date`        |
| Save                    | 只提交有变化的字段，提交期间禁止重复点击；成功后重新 GET                     |
| Clear                   | 明确清除字段，提交 `null`；未修改字段不发送                                  |
| Cancel / 切换产品       | Cancel 恢复已加载值；有未保存修改时切换产品须提示                            |

不包含：新建/删除产品、批量编辑、模糊搜索、售价/库存/标题/图片编辑、直接调用 marketplace 更新、手动触发 CatalogSync。

## 3. 字段合同

| 标签                               | API 字段                      | 校验                                                       |
| ---------------------------------- | ----------------------------- | ---------------------------------------------------------- |
| Manual Cost Price / 手动成本       | `manual_cost_price`           | `null` 或有限数值，`0 < value <= 99,999,999`；0 不代表清除 |
| Manual Restock Date / 手动到货日期 | `manual_presale_arrival_date` | `null` 或真实日历日期 `YYYY-MM-DD`                         |
| Protection Until / 保护截止日期    | `presale_info_protect_until`  | `null` 或真实日历日期 `YYYY-MM-DD`                         |

前后端保持相同规则；非法数字不得转换成 `null`。未知字段、空 PATCH 一律拒绝。日期不进行 UTC 时间转换，保护规则沿用 CatalogSync 的 JST 语义。

保存反馈：“手动值已保存并回读确认；生效成本以当前回读为准，平台后续同步状态另行确认。”不得把 PATCH 成功描述成平台价格、成本计算或库存已经更新。清除保护/到货信息的下游行为继续由现有同步规则决定。

## 4. Canonical 架构与归属

```text
Operator（现有 Cloudflare Access 登录）
  → Ops Portal /tools/product-update
  → Ops 服务端 /api/tools/products/:itemCode/manual-fields [GET / PATCH]
  → RPagentOS 产品 owner API
  → Supabase 产品主数据
```

成本相关数据库派生值由既有 pricing trigger 随写入计算，以 owner 回读为准（上线前核验 hosted trigger）。到货/保护规则和 marketplace 同步沿用既有 CatalogSync，平台同步不是保存请求必须等待的步骤。

- **Ops Portal**：拥有工具目录、界面和同源 API。在现有 Ops gateway 服务端增加范围明确的路由与 owner adapter，不新建独立服务。新工具不经过 `/order/` 或 OrderMgmt。
- **Ops 服务端 adapter**：验证 Access 身份、检查该身份的工具权限、校验请求格式并转发。业务字段规则、数据访问和写入留在产品 owner；不提供任意 URL、表名或字段透传。
- **RPagentOS**：拥有产品身份、允许字段、业务校验、写入及审计合同；Supabase 仍是产品主数据事实来源。为 Ops 增加独立、最小范围的服务端调用凭据，不借用 `ORDERMGMT_CATALOG_API_TOKEN`，不向浏览器暴露凭据。
- **OrderMgmt**：保持原有订单内编辑入口，通过既有 owner API 使用同一产品数据。新工具运行不依赖 OrderMgmt；本次不要求修改其代码。
- **CatalogSync**：保持既有计算归属、同步规则与调度。

### 后续产品主数据工具的共用规则

`/tools` 作为持续扩展的操作目录，`/api/tools/products/` 作为产品工具的同源 API 命名空间。首版用简单的静态工具注册（名称、路径、说明、所需 capability），不建设动态表单平台。

各工具共用 Access 身份验证、权限检查、owner client、错误格式和请求追踪；各业务动作仍有明确端点和字段白名单。建议首版 capability 为 `product.manual_fields.read` 与 `product.manual_fields.write`，由现有 operator 身份策略在服务端映射，不新增用户登录系统。

以后增加字段或工具时，先确定字段 owner、合法值、下游影响及权限，再扩展 owner 合同。新增工具不自动取得全部产品字段写权限。派生值保持只读，业务改写应作用于 owner 允许的输入字段。

界面明确提示：修改的是该 Item Code 的全局产品主数据，可能被多个订单/店铺消费；不是仅修改当前订单或某一刊登。

## 5. API 与错误处理

- 新增 `GET /api/tools/products/:itemCode/manual-fields`，由 Ops gateway 调用既有 owner `GET /api/internal/catalog/sku/:itemCode`，返回 `{ok:true, product:{...允许展示的 owner fields}}`。
- 新增 `PATCH /api/tools/products/:itemCode/manual-fields`，调用 owner `PATCH /api/internal/catalog/sku/:itemCode/manual-fields`。请求体仅包含发生变化的三个允许字段；返回 `{ok:true, product:{...owner 回传字段}}`，然后 GET 回读刷新表单。
- 新路由必须在 gateway 的通用页面代理之前匹配，保留 HTTP method，按错误来源映射 status，产品 API 返回 `Cache-Control: no-store`。
- owner endpoint 现有认证仅认可 OrderMgmt 专用写凭据；v2 必须扩展为明确认可独立 Ops caller 的受限权限。不得将当前 endpoint 误认为已经支持 Ops 调用。

| 情况                           | 用户可见行为                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------- |
| 400 校验失败                   | 保留输入，展示具体字段错误                                                                        |
| Ops 用户身份 401/403           | Access 会话无效或无工具权限；仅此情形走现有登录/权限提示                                          |
| owner 服务凭据 401/403         | 转为 502/503 `catalog_service_unavailable`，显示产品服务暂不可用和 request ID，不触发用户重新登录 |
| 404 `sku_not_found`            | 产品不存在，不提供创建动作                                                                        |
| 404 `commercial_state_missing` | 产品存在但缺少商业数据，保存失败；提示交由数据 owner 修复                                         |
| 409 重复 Item Code / 商业记录  | 数据冲突，停止保存，不自动选择记录                                                                |
| 502/503 owner 不可用或未配置   | 工具暂不可用；不把失败显示成空字段或不存在                                                        |
| PATCH 超时                     | 状态可能已写入，先 GET 核对，不自动重发                                                           |
| PATCH 成功但 GET 失败          | 显示“写入已返回成功，回读尚未确认”，保留待核验状态                                                |

查询切换时取消或忽略旧请求；保存必须绑定当前已加载的规范 Item Code，防止 A 产品的迟到响应覆盖 B 产品。

## 6. 权限、审计与并发取舍

### 一次登录，复用现有 Cloudflare Access

- Operator 已登录现有 Cloudflare Access 后，进入工具并查询/保存不再出现 Order Portal 登录框、密码框或 API token 输入框。未登录或会话过期只返回同一个 Access 登录流程；写请求不会登录后自动重放。
- 页面 `/tools`、`/tools/*` 与 `/api/tools/products/*` 均受现有 Access operator 策略保护。上线前核对实际 policy 覆盖；如需调整路径，沿用既有身份提供方和授权用户范围。
- Ops 服务端验证 Access JWT 签名、issuer、目标 application audience 和有效期，通过 Cloudflare Access 公钥验证。不能只检查 assertion 存在，也不能信任浏览器自行提供的 email/actor header。origin 直连不得绕过此验证。
- 服务端把已验证身份映射到允许的产品 capability；浏览器只使用现有 Access 会话。用户无权限时明确返回 403，不要求提供另一组凭据。
- Ops → RPagentOS 使用独立服务端凭据，并由 owner 验证 caller scope。这是服务间认证，对 operator 不增加认证操作。
- PATCH 仅接受同源 Origin 和 JSON Content-Type，不开放跨域写入；错误和日志不记录 JWT、凭据或无关个人数据。

### Owner 侧审计与并发

- 为新增 Ops caller 扩展 owner 审计：记录可信 caller、Access subject（由 Ops 验证后经受信服务链传递）、request ID、时间、产品、实际修改字段及结果。浏览器提供的 actor 不作为审计身份。
- 现有 `ordermgmt_manual_product_overrides_applied` 日志保持兼容；Ops 请求使用 caller-aware 产品事件，不冒充 OrderMgmt。首版仍是结构化应用日志，需核验部署日志留存与 request ID 可追溯性，不宣称已有事务性 before/after 审计账本。
- 首版沿用现有最后写入生效语义，提交 dirty fields 以避免覆盖未修改字段；同一字段仍存在并发覆盖风险。保存前刷新可减少风险，但不是原子并发控制。
- 不声称已有 CAS、请求去重账本或完整操作员审计。若评审要求防止同字段并发覆盖或事务性完整审计，须先扩展 RPagentOS owner 合同，并让新旧两个编辑入口共同使用；不能只在新页面实现伪保护。
- 值赋值 PATCH 重放通常产生相同字段值，但可能重复日志且覆盖后续编辑，因此不自动重试写请求。

## 7. 实施顺序与交付

1. 将本 v2 作为 governing Issue 合同，关联现有手动字段能力及中央 capability 声明。当前未向 GitHub 发布。
2. **RPagentOS PR**：支持独立 Ops caller 的受限 GET/PATCH 权限及 caller-aware 审计。复用既有产品写入逻辑；测试权限隔离、字段白名单、可信 actor、身份异常和现有 OrderMgmt caller 兼容性。
3. **Ops Portal PR**：在现有 gateway 实现 Access JWT 验证、capability 检查及两个同源产品 API；增加工具目录、表单与导航，验证输入、dirty PATCH、清除、竞态和回读。
4. 更新产品 owner 合同、工具使用说明、架构/当前状态及适用的中央 capability 声明。首版不预设数据库迁移，不改 CatalogSync 调度；OrderMgmt 无需新 PR。
5. 完成集成验收后，经发布授权按 owner→Ops API→工具界面顺序发布。服务端凭据在相应秘密存储配置；核验 Access 路径覆盖，全程不要求 operator 配置凭据。

开发使用各仓库独立干净 worktree；不覆盖已有未提交文档或其他产品工作。

## 8. 验收与回滚

- 从正式 `/tools` 点击进入、直接打开编辑 URL、刷新均正常；实际页面资源与 release 可核对。
- 无订单关联的已有产品能够读取、修改与清除三个字段；Order Portal 回读同一产品显示相同手动值。
- 去空格/大小写兼容；不存在、重复身份、缺少商业记录、非法日期/成本均有明确反馈。
- 已登录 Access 的 operator 从 Tools 到 Search/Edit/Save 全程无需额外认证；会话过期只走现有 Access 登录，原 PATCH 不自动重放。
- 未登录、伪造/过期/错误 audience 的 JWT、无 capability 身份、origin 直连绕过、跨域 PATCH 均被拒绝；前端构建及网络请求不包含服务端秘密。
- owner 能区分 Ops 与 OrderMgmt caller，错误 scope/凭据被拒绝；合法 Ops 写入日志可按 request ID 与可信 actor 追踪。
- 新工具端到端请求不访问 `/order/`；OrderMgmt 不可用时，工具仍可查询和保存。
- 只改一个字段不会提交其他字段；保存期间不能重复提交；快速切换 Item Code 不显示或保存错误产品。
- 模拟写入超时与回读失败，不出现虚假成功或自动重复写入；成本以 owner 回读为准，平台同步滞后不会被误报为保存失败或已完成平台同步；有效 Access + 无效 owner 凭据不得触发第二次登录。
- 本地/测试环境执行端到端用例；正式环境先做登录和只读验收，再对明确授权的一件产品做窄范围写入、owner 回读和恢复验证。
- 禁用 Ops 产品写 capability 或撤销 Ops 专用 owner 凭据可立即停止新工具写入，不撤销 OrderMgmt 凭据。回滚工具页面及 Ops adapter，保留原 Order Portal 功能；代码回滚不会自动恢复已修改数据。数据恢复按产品、字段、旧值经核对后走 owner API，防止覆盖后续合法编辑。

## 9. 核验依据与边界

v1 调研于 2026-09-08 刷新三个仓库的 `origin/main`：OrderMgmt `3d7cccf`、ops-portal `15936df`、RPagentOS `2f2d86d`。RPagentOS 本地 checkout 为旧功能分支且有其他改动，owner 合同以刷新后的 `origin/main` 源码核对。

- OrderMgmt：`docs/plans/issue-174-manual-product-updates.md`、`docs/01_ARCHITECTURE.md`、`docs/16_DATABASE_GOVERNANCE.local.md`、`src/lib/portal/product-update.mjs`、`portal-api/src/routes.mjs`、`portal-api/src/auth.mjs`、`portal/src/components/detail/ProductManualFields.tsx`。
- Ops Portal：`src/routes/`、`gateway/server.mjs`；当前 main 没有 `/tools` 页面，现有网关已承接 `/order/`。
- RPagentOS：`origin/main:src/api/internal-catalog.ts`、`src/api/internal-catalog-manual-fields.test.ts`。现有 GET 缺少 commercial row 时可返回空手动字段；PATCH 会拒绝，所以首版必须保留其明确错误提示。
- 正式 `/tools` 未认证 HTTP 请求返回 302；v1 调研未执行已登录页面验收、产品实时查询、数据库写入或部署。源码合同不等同于线上可用性证明。

v2 为基于已核对合同的设计修订；新增 Ops adapter、Access JWT 验证、独立 owner caller 及审计扩展均待实现和验收，不是已部署能力。

## 10. 版本记录

| 版本 | 日期       | 变更                                                                                                                    |
| ---- | ---------- | ----------------------------------------------------------------------------------------------------------------------- |
| v1   | 2026-09-08 | 首版评审计划；限定三个字段、独立精确查询、复用 owner 写入链路，记录并发与审计限制                                       |
| v2   | 2026-09-08 | 取代 v1：Ops 直接调用产品 owner；支持后续产品业务值工具扩展；仅复用现有 Access 登录；新增独立服务 caller 与身份审计要求 |
| v3   | 2026-09-08 | 采纳 codex-b 评审：成本按 trigger/owner 回读；分层认证错误映射；用户授权实施部署                                        |

## 2026-09-08 发布证据

- Ops 实现 PR retailpulses/ops-portal#82：e938832bfe17b74b900a8f31cd7ca346e47702d0；Pages run 34182187305、gateway run 34182200835 均成功。
- Owner PR retailpulses/RPagentOS#122：df7a0a39a6fa246b55beddf4fab6c75c6e450dbb；Pages run 34182183427 成功。
- 中央声明 PR retailpulses/rp-governance-kit#75 已合并。
- Hosted pricing trigger 已通过 rp_agent_readonly、read-only transaction 核验。
- N511P407695W 的空手动到货日期原值写回：PATCH 200、GET 200、三个手动字段及成本无变化；request ID product-tool-canary-20260908。
- Gateway 精确版本 health 通过、直接未认证产品 API 401、正式域名未登录 302 到现有 Access。
- 浏览器本地 fixture 查询、保存、清除通过；正式浏览器仍等待用户完成现有 Access 登录，不声称完整 operator 验收完成。

## 2026-09-10 Effective Restock Date 增量

- GigaB2B Import 需求无限期暂停，未实现或部署。
- Product update tool 增加只读 `effective_restock_date` 展示；其值来自 owner 当前已存储的 `product_commercials.restock_date`。
- 显式 `null` 显示 `None`；字段缺失或非法显示 `Unavailable`。Manual Restock Date 保存后的 GET 会重新读取当前值，但不承诺同步任务已立即重算。
