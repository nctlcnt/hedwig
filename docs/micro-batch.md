# 邮件分类 Micro-Batch 改造 Plan

## 1. 目标

将现有邮件分类流程从：

`1 封邮件 → 1 次 LLM request`

改造成：

`N 封独立邮件 → 1 次 LLM request → 返回 N 个独立分类结果`

核心目标不是改变“每封邮件独立分类”的业务语义，而是改变 LLM request 的执行方式，降低请求次数、缓解 429、提高吞吐，同时保持现有分类结果的数据结构和下游 digest 行为不变。

本阶段只处理 **classification micro-batch**。

## 2. 本阶段范围

本阶段包含：

1. 将 `classifier.classify(email)` 扩展为 `classifier.classifyBatch(emails)`。
2. 在 classification worker 中增加 micro-batch 切分。
3. 使用 token budget + item count 双重限制 batch 大小。
4. 将多个邮件放入一次 LLM request，并要求模型返回逐邮件结构化结果。
5. 通过 `email_id` 做输入输出关联，不依赖数组顺序。
6. 增加 batch-level validation。
7. 增加 item-level partial failure 处理。
8. 复用现有 OpenAI SDK client 的指数退避 + jitter（`config.classifier.maxRetries` / `requestTimeoutMs`，已支持读取 429 的 `Retry-After`），不在 batch 层重新实现一套退避逻辑；batch 层只新增“单次请求重试耗尽后”的降级路径。
9. 在第一阶段保持有界并发，默认只允许 1 个 batch 同时执行。
10. 保留单封 fallback，确保极端情况下单邮件仍然可以完成分类。
11. 增加 batch size、token、耗时、429、失败率等 metrics/logging。
12. 增加 unit test、integration test 和 regression test。

## 3. 本阶段明确不做

以下内容全部留到后续阶段，不在此次改造中混入：

* 不修改每日 digest / `section-narrator.ts`
* 不修改 Gmail History API 获取逻辑
* 不接 Gmail API batch request
* 不引入 Gmail Push / Pub/Sub
* 不更换 LLM provider
* 不更换现有分类 schema
* 不调整业务分类规则
* 除第 16 节所述、幂等写入必需的 `message_classifications` 唯一约束迁移外，不修改 SQLite 数据模型
* 不引入复杂的 Redis / Kafka / 外部 queue
* 不做跨邮件联合推理
* 不允许模型利用其他邮件内容改变某封邮件的分类

一个关键边界是：

> **Batch 只是传输和推理优化，不改变分类语义。**

每封邮件仍然必须像单独分类时一样独立得到：

* category
* summary
* importance
* action

## 4. 当前问题

当前逻辑：

```ts
for (const ref of refs) {
  const email = await mailGateway.getMessage(...)
  const classification = await classifier.classify(email)
}
```

意味着：

假设一个 5 分钟周期来了 30 封邮件：

```text
30 emails
→ 30 LLM requests
```

这会导致：

* request 数量线性增长
* 突发邮件造成 request burst
* 更容易触发 provider 429
* 网络/API overhead 较高
* 整个 worker 执行时间变长
* retry 成本高

目标：

```text
30 emails
→ 3~4 LLM requests
```

例如：

```text
Batch 1: 10 emails
Batch 2: 10 emails
Batch 3: 10 emails
```

业务结果仍然是 30 个独立 classification record。

## 5. 目标架构

改造后的 classification flow：

```text
Gmail History API
       │
       ▼
获取本周期 refs
       │
       ▼
过滤已处理 / spam / 无效邮件
       │
       ▼
load email content
       │
       ▼
pending emails
       │
       ▼
token-aware batch builder
       │
       ├── Batch A
       ├── Batch B
       └── Batch C
       │
       ▼
Classification Worker
       │
       ├── classifyBatch(A)
       ├── classifyBatch(B)
       └── classifyBatch(C)
       │
       ▼
validate / reconcile results
       │
       ├── success → write SQLite
       └── failed item → single-email retry
```

第一阶段默认：

```text
batch concurrency = 1
```

也就是先保证稳定性，再考虑提高并发。

**这一步隐含一次循环结构调整，需要在第 25 节 Step 7 里显式列出来**：现在的 `runAccountClassificationPass`（`digest.ts:127-156`）是单遍流式循环——每次迭代只取一封邮件的内容（`mailGateway.getMessage`），取到就立刻分类。上面这条 pipeline 要求先把本轮所有 pending 邮件的内容都取完（`load email content` → `pending emails`），才能进入 batch builder，也就是把"边取信边分类"的单阶段循环，拆成"先取完信、再分批分类"的两阶段流程。按现在 5 分钟一轮、单轮几十封邮件的量级，多出来的内存占用可以接受，但这是一次真实的循环重构，不是 Step 7（改造 worker 循环结构）里顺带发生的小事：某封邮件在取信阶段失败（比如 Gmail API 报错）时应该跳过该邮件，不能阻塞同批其它邮件进入 batch builder，这一点需要单独测试。

## 6. Batch 大小策略

不要单纯按照邮件数量切 batch：

```ts
emails.slice(0, 10)
```

而应使用两个限制：

```text
maxItems
+
maxInputTokens
```

例如第一版配置：

```ts
const BATCH_CONFIG = {
  maxItems: 10,
  maxInputTokens: 24000,
}
```

实际值应该做成 config，而不是硬编码。

建议初始范围：

```text
8~16 emails / batch
```

第一版可以从：

```text
maxItems = 10
maxInputTokens = 24k
```

开始。

实际 batch 满足：

```text
email count <= maxItems
AND
estimated input tokens <= maxInputTokens
```

只要加入下一封邮件后会超过任意一个限制，就结束当前 batch。

例如：

```text
A = 1.5k tokens
B = 2k
C = 4k
D = 800
...
```

即使目前只有 8 封，如果再加入一封会超过 token budget，也必须提前结束 batch。

## 7. 特殊邮件边界

单封邮件如果本身就超过 batch token budget：

```text
email tokens > maxInputTokens
```

不能让它卡住整个 batch builder。

处理方式：

```text
超长邮件
   ↓
single-email classification path
```

也就是说：

> **batch 只处理适合 batch 的邮件，超长单件允许自动 fallback 到 single mode。**

此次不额外实现 long-context summarization。

## 8. Classifier API 改造

保留旧接口作为 fallback：

```ts
classify(email: EmailMessage): Promise<Classification>
```

增加：

```ts
classifyBatch(
  emails: EmailMessage[]
): Promise<BatchClassificationResult[]>
```

`Classification` 沿用 `types.ts` 里已有的定义（`category`、`importance`、`summary`、`attentionPoints`、`suggestedActions`、`confidence`、`reason?`、`provider`，没有 `action` 字段），不新造一套精简字段。batch 只是在这个既有结构外面包一层 `emailId` 用于输入输出关联：

```ts
interface BatchClassificationResult {
  emailId: string
  classification: Classification
}
```

batch API 必须满足：

```text
N input emails
→
N output results
```

但系统不能假定模型真的返回 N 条，因此调用方必须验证。

## 9. Prompt 设计边界

batch prompt 必须明确告诉模型：

> These emails are independent classification tasks.

模型必须：

* 独立分析每封邮件
* 不使用其他邮件内容改变当前邮件判断
* 每个输入 email_id 对应一个 result
* 不新增 email
* 不删除 email
* 不合并两个 email
* 不依赖数组顺序

**输入格式**：延续现有单邮件调用的 JSON 风格（`llm/openai-compatible-classifier.ts` 里 `buildUserContent` 用的 `EMAIL_JSON:\n${JSON.stringify(payload)}`），把多封邮件表示成一个 JSON 数组，不改用纯文本分隔符拼接。纯文本分隔符（`EMAIL_ID: ...` / `BODY: ...` 这种格式）有一个具体风险：如果某封邮件正文里恰好包含类似 `EMAIL_ID: xxx` 的文本（比如转发邮件里嵌套了另一封邮件的头部），会混淆模型对邮件边界的判断；JSON 数组里每个字段都经过标准转义，不存在这个问题。

```text
EMAILS_JSON:
[
  {
    "emailId": "abc123",
    "from": "...",
    "subject": "...",
    "date": "...",
    "headers": [...],
    "snippet": "...",
    "text": "..."
  },
  {
    "emailId": "def456",
    "from": "...",
    "subject": "...",
    "date": "...",
    "headers": [...],
    "snippet": "...",
    "text": "..."
  }
]
```

单封邮件的字段沿用 `buildUserContent` 现在已经在传的那几项（`from`、`subject`、`date`、`headers`、`snippet`、`text`），只是外面多包一层数组，并加上 `emailId`。

**输出格式**：现有单邮件调用用的是 `response_format: { type: 'json_object' }`（`llm/openai-compatible-classifier.ts:93`）。这个模式要求模型输出的根节点是一个 JSON *对象*，不能是裸数组，所以 batch 输出不能直接是 `[ {...}, {...} ]`，需要包一层：

```json
{
  "results": [
    {
      "emailId": "abc123",
      "category": "action",
      "summary": "...",
      "attentionPoints": ["..."],
      "suggestedActions": ["..."],
      "importance": 82,
      "confidence": 0.7,
      "reason": "..."
    },
    {
      "emailId": "def456",
      "category": "fyi",
      "summary": "...",
      "attentionPoints": [],
      "suggestedActions": [],
      "importance": 20,
      "confidence": 0.6,
      "reason": "..."
    }
  ]
}
```

每个 item 的字段和现在单邮件用的 `SCHEMA_HINT`（`llm/openai-compatible-classifier.ts:11-20`）保持一致，只是多了 `emailId`，避免 batch 和单邮件两套 schema 各自漂移。

必须使用 structured output / schema validation；如果当前 provider 支持严格 JSON schema，则优先使用。

## 10. 输入清洗保持现状不变

本次 micro-batch 改造不改变邮件正文清洗策略。

也就是说：

```text
当前 email normalization
→
当前 body truncation
→
batch builder
```

不要在本次任务里同时加入：

* thread summarization
* signature removal
* quoted reply removal
* HTML 清洗重构

这些都会同时改变模型输入和分类行为，导致无法判断 micro-batch 本身是否造成 regression。

本阶段首先保证：

> **单封分类输入保持与改造前尽可能一致。**

## 11. Batch 执行流程

worker 逻辑目标：

```ts
const emails = await loadPendingEmails()

const batches = buildBatches(emails)

for (const batch of batches) {
  const results = await classifier.classifyBatch(batch)

  const validResults = validateBatchResults(batch, results)

  await persist(validResults)
}
```

重要的是：

```ts
for ... of
```

虽然仍然可以存在，但此时 loop 是：

```text
batch → batch → batch
```

而不是：

```text
email → email → email
```

第一阶段不做并行 batch。

## 12. Batch Result Validation

LLM 返回结果后必须进行 reconciliation。

验证以下条件：

### 12.1 每个 input email 最多一个 result

```text
duplicate emailId
→ batch invalid
```

### 12.2 所有 result 的 emailId 必须属于 input set

```text
unknown emailId
→ reject that result
```

### 12.3 找出 missing items

例如输入：

```text
A B C D E F G H
```

输出：

```text
A B C D F G H
```

则：

```text
E = missing
```

不能因此让整个 batch 失败。

### 12.4 Schema 必须完整

例如：

```text
category invalid
summary missing
importance invalid
```

则该 item 标记为 invalid。

## 13. Partial Failure 策略

处理规则：

```text
Batch success
→ 全部写库

Batch partial success
→ valid results 写库
→ missing / invalid items 单封 retry

Batch schema parse failure
→ batch 不写库
→ 交给 SDK 级 retry（第 14 节）
```

如果 SDK 级 retry 耗尽后仍然失败：

```text
batch 请求最终失败
        ↓
split batch
        ↓
对拆分后的子 batch 重新发起请求（同样带 SDK 级 retry）
```

建议最多拆分一次：

```text
10 emails
  ↓
5 + 5
```

若仍失败：

```text
single-email fallback
```

这样避免一个坏 batch 无限循环。

## 14. Retry 策略

单次 batch 请求内的 transient error（429、5xx、timeout、network error、temporary provider error）不在 batch 层重新实现退避逻辑，而是复用 `llm/openai-compatible-classifier.ts` 里已经在用的 OpenAI SDK client：`maxRetries`、`requestTimeoutMs` 这两个配置项（对应 `config.classifier.maxRetries` / `config.classifier.requestTimeoutMs`，当前默认值分别是 4 和 60000ms）已经驱动 SDK 自带的指数退避 + jitter，并且已经会读取并遵循响应头里的 `Retry-After`（`config.ts` 里对 `maxRetries` 字段的注释写明了这一点）。`classifyBatch` 内部发起请求时，直接复用现有的 client 构造方式即可，不新增一套 429 专用的 backoff 参数或配置。

对于明显的永久性错误，不依赖也不需要 SDK 去反复重试，例如：

```text
invalid request
invalid schema configuration
authentication failure
unsupported model
```

这类错误不属于 429/5xx/timeout，SDK 本身也不会重试，会直接抛出。

batch 层需要处理的“retry”，指的是**单次请求的 SDK 重试已经全部耗尽、仍然失败之后**该怎么办，这是一个固定步数的降级序列，而不是又一层指数退避循环：

```text
batch 请求（含 SDK 内部重试）最终失败
        ↓
split batch（10 → 5 + 5，最多拆分一次）
        ↓
拆分后的子 batch 仍然失败
        ↓
single-email fallback（逐封走 classify()，复用其已有的
  primary LLM → fallback LLM → rule 三级降级链）
```

这个序列本身不需要一个额外的“重试次数”配置；序列里每一次实际发出的 HTTP 请求（整 batch、拆分后的子 batch、或最终单封 fallback）各自的 transient error 重试，统一沿用 `config.classifier.maxRetries` / `requestTimeoutMs`。

## 15. 429 的特殊处理

429 的识别、`Retry-After` 读取、指数退避 + jitter，全部由第 14 节里说明的 OpenAI SDK client 承担，batch 层不重复处理这三件事。batch 层只需要保证两点，而且这两点在当前架构下不需要额外代码：

1. 当前 batch（含它内部的 SDK 级重试，可能持续数秒到数十秒）在跑的时候，不启动下一个 batch——这一点由 worker 里 `for (const batch of batches) { await classifier.classifyBatch(batch) }` 这种顺序 `for...of` 循环天然保证（第一阶段 `batchConcurrency = 1`），不需要额外的锁或队列去单独实现。
2. SDK 级重试耗尽、这次请求最终仍然失败后，按第 14 节的降级序列（split → single fallback）处理，不在 catch 块里对同一个请求再手写一轮 `sleep` + retry。

第一阶段的核心目标是：

```text
减少 request 数量
+
控制 concurrency
+
复用已经验证过的退避实现
```

而不是在 batch 层重新发明一套 429 处理逻辑，也不是通过固定 `sleep(1000)` 来“解决限流”。

## 16. Database 状态边界

本阶段优先复用现有“已处理 / 未处理”机制（`findProcessedGmailIds` 在每轮运行开始时一次性算出 `alreadyProcessed` 集合，见 `digest.ts`）。

不要为了 batch 引入复杂状态机。

但必须保证：

> 同一封邮件不能因为 batch retry 被重复写入多个 classification。

**现状核实**：`message_classifications` 表（`db.ts` 建表语句）目前在 `(account_id, gmail_id)` 上只有一个普通索引，没有唯一约束；`saveClassification`（`db.ts:112`）是一条纯 `insert`，不是 upsert。`alreadyProcessed` 只在每轮运行开始前算一次，运行期间不会刷新。这意味着一旦本次改造引入的 split-batch retry / single-email fallback retry 在同一轮运行内对同一封邮件发生第二次写库，现有 schema 没有任何机制能阻止产生重复行——这不是一个可以先跳过、以后再看的边缘情况，而是本次改造要交付的批次重试能力从第一天起就会触碰到的问题。

因此本阶段包含一次明确的 schema 迁移（不属于“如果需要”的可选项）：

1. 给 `message_classifications` 加 `unique(account_id, gmail_id)`。
2. `saveClassification` 改成 upsert：

```sql
insert into message_classifications (...)
values (...)
on conflict(account_id, gmail_id) do update set ...
```

（Step 1 已完成，当前的 upsert 写法见 `db.ts` 的 `saveClassification`。原先参考的 `followup-store.ts` 已随 follow-up 功能一起移除。）

迁移方式沿用 `db.ts` 里已有的“重建表 + 迁移旧数据”模式（参考文件中对 `message_classifications_legacy_*` 的处理），不引入新的迁移框架。

## 17. Idempotency

同一 batch 可能因为：

* worker crash
* timeout
* provider response 已成功但本地写库失败
* retry（batch 级 SDK 重试耗尽后触发的 split / 单封 fallback）

而被再次执行。

因此：

```text
classification(emailId)
```

必须幂等。采用第 16 节已经确定的方案：

```sql
INSERT ... ON CONFLICT(account_id, gmail_id) DO UPDATE
```

`run_id` 仍然写入本次运行的 id，冲突时一并更新，这样重复写入只会把同一封邮件的记录刷新成本轮结果，不会产生第二行。这一点不再是一个开放的技术选型，而是本阶段必须完成、且已在第 16 节给出具体迁移路径的既定动作。

## 18. Observability

至少增加以下日志：

```text
classification_batch_started
classification_batch_completed
classification_batch_failed
classification_batch_retry
classification_item_fallback
classification_429
```

每次 batch 至少记录：

```text
batchId
emailCount
estimatedInputTokens
durationMs
successCount
failureCount
retryCount
fallbackCount
```

不要把完整 email body 写进日志。

可以记录：

```text
emailId
subject hash / message id
batchId
```

避免敏感邮件内容泄漏。

### 18.1 和现有运维告警的关系

现在 `runAccountClassificationPass` 只在某封邮件的 `classification.provider === 'rule-fallback'` 时才把它推进 `classifierFailures`（`digest.ts:139-146`），通过 `notifyClassifierFailures` 发到运维报警渠道（Telegram 运维群 `TELEGRAM_DEBUG_CHAT_ID`）。这条判断只覆盖"LLM 调用本身失败、最终退到规则分类器"这一种情况。

batch 化之后还会出现一种新情况：LLM 调用本身成功，但返回结果里某封邮件的 item 被 batch validation 判定为 missing / unknown emailId / invalid schema（第 12 节），随后单封 retry 用真实 LLM 成功分类——这种邮件最终的 `provider` 不是 `rule-fallback`，不会触发现有告警，但"batch 把这封邮件的结果搞丢了"本身是一个值得运营关注的信号（可能意味着 prompt、schema 或 body truncation 有问题）。

因此这一节的 `classification_item_fallback` 日志事件触发时，需要同时调用 `classifierFailures.push(...)` / `notifyClassifierFailures`，和现有 `rule-fallback` 判断走同一条运维告警路径，而不是只留在新 metrics 里、需要单独查看才能发现。

## 19. Metrics

至少记录：

```text
emails_processed
batches_processed
avg_batch_size
avg_input_tokens_per_batch

llm_requests
429_count
5xx_count
timeout_count

batch_success_rate
item_success_rate
single_fallback_rate

classification_latency
batch_latency
```

最重要的两个指标：

```text
LLM requests / email
```

以及：

```text
single-email fallback rate
```

目标是明显低于当前的：

```text
1 request / email
```

## 20. 测试策略

### Unit Test

测试：

```text
正常 10 封
不足 10 封
超过 maxItems
超过 token budget
单封超长邮件
空邮件列表
重复 emailId
missing result
unknown emailId
invalid category
invalid JSON
```

### Batch Builder Test

例如：

```text
12 emails
maxItems=10
```

必须得到：

```text
10 + 2
```

例如：

```text
6 emails
总 token > budget
```

必须正确拆分，而不能单纯按数量切分。

### Retry Test

模拟：

```text
第一次 429
第二次成功
```

必须：

```text
retry
→ success
```

模拟：

```text
429
429
429
```

必须最终进入 fallback，而不是无限循环。

### Partial Failure Test

输入：

```text
A B C D E
```

模型返回：

```text
A B C E
```

必须：

```text
A B C E → 正常落库
D → single-email retry
```

### Idempotency Test

同一 email 连续处理两次：

```text
第一次 classification
第二次 classification
```

数据库最终只能有一个有效 classification。

## 21. Regression Test

在正式切换前，建立一组固定的历史邮件样本。

建议至少：

```text
50~100 封
```

覆盖：

```text
action
fyi
newsletter
notification
long email
short email
threaded email
HTML email
中文
英文
混合语言
```

先用现有 single-email classifier 跑一遍，保存 baseline。

再用 micro-batch 跑同一组邮件。

比较：

```text
category
importance
summary validity
action validity
```

本阶段不要求 batch 输出文本逐字符一致。

主要验证：

> **batch 化没有导致业务分类语义出现系统性变化。**

## 22. 验收标准

### Functional Acceptance

必须满足：

1. 一次 batch 请求可以正确处理多封邮件。
2. 每封 input email 都能通过 `emailId` 对应自己的 result。
3. 不依赖数组顺序。
4. 不出现跨邮件结果串线。
5. missing / invalid item 可以单独 retry。
6. 单封 fallback 可用。
7. 重试不会产生重复数据库记录。
8. 原有 classification schema 和 digest 输入保持兼容。

### Reliability Acceptance

必须满足：

```text
429 → 自动 backoff → retry
```

且：

```text
retry exhausted
→ fallback
```

系统不能因为单个 batch 失败导致整个 cron run 永久失败。

### Performance Acceptance

在同一批历史邮件上：

```text
LLM request count
```

必须显著低于旧实现。

例如：

```text
30 emails

旧：
30 requests

新：
~3 requests
```

具体 batch 数量由 token budget 决定，不强制要求固定 3。

同时：

```text
single-email fallback rate
```

在正常邮件数据上应保持很低；第一版可以以：

```text
< 5%
```

作为工程观察阈值。

### Accuracy Acceptance

在 baseline regression set 上：

```text
category agreement
```

不允许出现明显系统性下降。

建议把：

```text
baseline classification
vs
micro-batch classification
```

做成自动比较报告。

对于存在差异的样本，人工抽查，而不是要求所有 summary 文本完全一致。

### Stability Acceptance

连续运行多个 cron cycles 后：

```text
无重复 classification
无 batch 无限 retry
无 pending 邮件永久卡死
无明显 429 storm
```

## 23. Rollout 策略

不要第一天直接完全切换。

建议：

### Phase 1 — Shadow / Compare

对应第 25 节 Step 13：开 `CLASSIFIER_MICRO_BATCH_SHADOW`。相同邮件集合：

```text
旧 classifier（写库，权威结果）
+
new batch classifier（只跑一次，记录差异，不写库）
```

并行比较结果，但只让旧结果进入正式数据。

目的：

```text
验证 batch 是否改变分类质量
```

### Phase 2 — Small Production Rollout

对应第 25 节 Step 14：往 `CLASSIFIER_MICRO_BATCH_ACCOUNTS` 里加入一个账号的 `accountId`，只有这个账号在本轮 pass 里把 batch 结果当作权威结果写库，其余账号继续走原来的单邮件路径。

持续观察：

```text
429
latency
fallback
classification difference
```

### Phase 3 — Full Rollout

确认稳定后，把 `CLASSIFIER_MICRO_BATCH_ACCOUNTS` 扩大到全部账号。

保留：

```text
feature flag
```

便于出现问题时快速切回：把该账号从 `CLASSIFIER_MICRO_BATCH_ACCOUNTS` 里移除，或者直接关闭 `CLASSIFIER_MICRO_BATCH_ENABLED`，回到 old single-email path。

## 24. 建议的配置

第一版，挂在 `AppConfig.classifier` 下面（不单独开一个顶层配置对象，和现有 `maxRetries` / `requestTimeoutMs` 放在一起，接入方式见第 25 节 Step 9）：

```ts
classifier: {
  // ...现有字段（provider、rulesPath、llm、fallbackLlm、maxRetries、requestTimeoutMs）不变

  microBatchEnabled: true,
  maxBatchItems: 10,
  maxBatchInputTokens: 24000,
  batchConcurrency: 1,
  enableSingleItemFallback: true,
  enableBatchSplitFallback: true,

  // 灰度相关，见第 25 节 Step 13、14，第一版先都关闭 / 留空
  microBatchShadow: false,
  microBatchAccounts: [] as string[],
}
```

单次 HTTP 请求（整 batch / 拆分后的子 batch / 单封 fallback）的 transient error 重试，直接复用同一个 `classifier` 配置下已有的 `maxRetries` 和 `requestTimeoutMs`（第 14 节），这里不重复定义一份 maxRetries。

全部通过 config 管理，避免写死在 classifier 内部。

## 25. 实现步骤

以下步骤按依赖关系排序，不是随意顺序都能并行：涉及数据库写入路径的迁移（Step 1）排在所有会触发重试写库的逻辑（Step 7、8）之前；`classify(email)` 改成复用 batch 逻辑（Step 6）排在 batch 的 prompt（Step 4）和 validator（Step 5）都完成之后。每一步新增的测试文件，都要按 `AGENTS.md` 的要求同步加进 `package.json` 的 `test` 脚本串联列表（`tsx a.test.ts && tsx b.test.ts && ...`），不要留到最后统一补。

### Step 1 — message_classifications 唯一约束迁移 + upsert

按第 16 节，提前到最前面做，因为后面只要涉及往 `message_classifications` 写数据，都要建立在幂等写入之上：

1. 给 `message_classifications` 加 `unique(account_id, gmail_id)`（沿用 `db.ts` 里已有的表重建迁移模式）。
2. `saveClassification` 改成 `insert ... on conflict(account_id, gmail_id) do update`。

这一步完成后，单邮件路径本身行为不变；在 `db.test.ts` 里补一个"同一 `(account_id, gmail_id)` 写两次，最终只留一行"的用例验证迁移生效。

### Step 2 — 定义 batch 类型，搭出 classifyBatch 骨架

新增第 8 节定好的类型和函数签名：

```ts
classifyBatch(emails: EmailMessage[]): Promise<BatchClassificationResult[]>
```

这一步先给一个内部逐封调用现有 `classify(email)` 的实现——这不是半成品占位，而是一个功能正确、只是还没做批量 LLM 调用的版本。目的是让 `classifyBatch` 这个接口从这一步起就能被 Step 7 的 worker 改造使用和测试，不用等 Step 3-6 全部完成。保留 `classify(email)` 不变。

### Step 3 — 实现 batch builder

新增：

```ts
buildClassificationBatches(emails)
```

负责：

```text
maxItems
+
maxInputTokens
+
oversized email handling
```

不依赖 Step 2 里 `classifyBatch` 的具体实现，可以和 Step 2 并行开始。

### Step 4 — 改造 prompt

按第 9 节，把单邮件 prompt 改成：

```text
multiple independent emails
→ JSON 数组输入（EMAILS_JSON）
→ { "results": [...] } 输出
→ emailId mapping
```

### Step 5 — 增加 result validator

新增：

```ts
validateBatchResults(inputEmails, results)
```

负责第 12 节列出的四类校验：

```text
duplicate
unknown id
missing id
invalid schema
```

### Step 6 — 把 classifyBatch 换成真正的批量调用，并让 classify(email) 复用同一套逻辑

到这一步，Step 3（builder）、Step 4（prompt）、Step 5（validator）都已经就绪。把 Step 2 里"逐封调用 `classify()`"的实现，换成真正的一次 LLM 请求处理整个 batch，并接入 Step 5 的 validator。然后把 `classify(email)` 改造成内部调用 `classifyBatch([email])`，复用同一套 prompt 拼装、response 解析、schema 校验逻辑，避免维护两套平行实现。

### Step 7 — 改造 worker 循环结构

这一步包含两个变化：

1. 把 `runAccountClassificationPass`（`digest.ts:127-156`）现在"取一封信 → 立刻分类"的单遍流式循环，拆成"先取完本轮所有 pending 邮件内容 → 再分批分类"的两阶段流程（对应第 5 节的 pipeline）。取信阶段单封邮件失败时跳过该邮件，不影响其余邮件进入 batch builder。
2. 把分类阶段的循环粒度从 `for email → classify(email)` 改成 `for batch → classifyBatch(batch)`。

因为 Step 1 已经完成，这一步即便持久化逻辑有问题被重复调用，也不会在数据库里产生重复行，可以放心接着做 Step 8。

### Step 8 — 增加重试耗尽后的降级序列

429 / transient error 的重试完全交给现有 OpenAI SDK client（`config.classifier.maxRetries` / `requestTimeoutMs`，见第 14、15 节），这一步不新增退避逻辑，只实现 SDK 重试耗尽后的降级序列：

```text
batch 请求失败（SDK 重试已耗尽）
→ split（最多一次）
→ single-email fallback（复用 classify() 已有的三级降级链）
```

### Step 9 — 把新配置接进 config.ts

按第 24 节的字段，照现有 `integer(name, fallback)` / `boolean(name, fallback, env)` helper（`config.ts:18-28`）的写法加对应 env var，例如 `CLASSIFIER_MICRO_BATCH_ENABLED`、`CLASSIFIER_MAX_BATCH_ITEMS`、`CLASSIFIER_MAX_BATCH_INPUT_TOKENS`，挂到 `AppConfig.classifier` 下面，不单独开一个顶层配置对象。Step 13、14 用到的 `CLASSIFIER_MICRO_BATCH_SHADOW`、`CLASSIFIER_MICRO_BATCH_ACCOUNTS` 也在这一步一起加上（先都关闭 / 留空）。

### Step 10 — 增加 metrics / logging

加入：

```text
batch size
tokens
latency
429
retry
fallback
success
```

`classification_item_fallback` 触发时同时接入现有 `classifierFailures` / `notifyClassifierFailures` 的运维告警路径（见第 18.1 节），不要只写进新 metrics。

### Step 11 — 建 regression dataset

写一个一次性脚本（参照 `apps/backend/scripts/` 下现有脚本的写法），从当前账号的 Gmail 或本地 `messages` / `message_classifications` 表里，按第 21 节要求的类别、语言、长度维度做分层抽样，抽 50~100 封；对每一封重新跑一次现有单邮件 `classify()`，把 `{ emailId, 邮件关键字段, baseline classification }` 写成本地 JSON 文件，存到 `data/regression/`。这个目录和现有 `data/` 一样整个 gitignore（`.gitignore:13`），因为里面是真实邮件内容，不能提交进仓库。这份文件是 Step 12 比较用的基准。

### Step 12 — 离线 regression 对比

写一个脚本读取 Step 11 生成的 baseline 文件，对同一批邮件跑 `classifyBatch`，按第 21 节列的维度（category、importance、summary validity、action validity）生成一份对比报告。这一步完全本地跑，不依赖生产环境，是第 20 节 Regression Test 的实际落地方式，可以在 Step 6-8 完成后随时重复运行来验证改动没有引入 regression。

### Step 13 — 生产环境 shadow 分支（对应第 23 节 Phase 1）

在 Step 9 加的 `CLASSIFIER_MICRO_BATCH_SHADOW` 开关基础上：开启后，`runAccountClassificationPass` 在正常走现有单邮件 `classify()` 写库的同时，额外对同一批 pending 邮件跑一次 `classifyBatch()`，只记录两者的分类差异（复用第 18 节的日志事件），不写库、不影响 `push_now` 判断；这次额外调用本身失败也不能影响主流程（包一层 try/catch，失败只记日志）。这是第 23 节 Phase 1"旧 classifier + new batch classifier 并行比较"的具体实现方式。

### Step 14 — Feature flag 灰度上线（对应第 23 节 Phase 2、3）

灰度粒度按账号（`accountConfig.id`），不做按邮件抽样的百分比灰度：`createClassifier` 现在就是在 `runAccountClassificationPass` 里按每个 account pass 单独创建的（`digest.ts:117`），账号边界是现成的、不需要另外发明抽样机制的灰度粒度。具体做法：Step 9 加的 `CLASSIFIER_MICRO_BATCH_ACCOUNTS`（逗号分隔账号 id）里的账号，在本轮 pass 里把 `classifyBatch` 的结果当作权威结果写库；不在列表里的账号继续走原来的单邮件路径。确认稳定后把这个列表扩大到全部账号；`CLASSIFIER_MICRO_BATCH_ENABLED` 这个总开关始终保留，用于随时整体切回单邮件路径。

## 26. Definition of Done

当以下条件全部满足时，本次 micro-batch 改造视为完成：

```text
[✓] classifyBatch API 完成
[✓] token-aware batch builder 完成
[✓] structured output 完成
[✓] emailId reconciliation 完成
[✓] partial failure handling 完成
[✓] 重试耗尽后的降级序列（split → single fallback）完成，复用现有 SDK 级 backoff
[✓] single-email fallback 完成
[✓] message_classifications 唯一约束迁移 + upsert（idempotent persistence）完成
[✓] config.ts 配置接入完成
[✓] metrics/logging 完成
[✓] unit tests 完成，并已加入 package.json 的 test 脚本链
[✓] regression dataset 建立 + 离线 regression 对比完成
[✓] 生产环境 shadow 分支（CLASSIFIER_MICRO_BATCH_SHADOW）完成
[✓] 按账号灰度的 feature flag（CLASSIFIER_MICRO_BATCH_ACCOUNTS）完成
[✓] production rollout 完成
```

最终希望系统从：

```text
每封邮件：
1 LLM request
```

变成：

```text
每批邮件：
1 LLM request

同时：
每封邮件仍然拥有独立 classification result
```

因此本次改造的成功标准不是“把很多邮件塞进一个 prompt”这么简单，而是：

> **在不改变邮件分类业务语义的前提下，把 LLM 调用粒度从 per-email 降到 micro-batch，并确保 batch failure、429、partial result、retry、重复写入等异常场景都不会破坏现有 classification pipeline。**
