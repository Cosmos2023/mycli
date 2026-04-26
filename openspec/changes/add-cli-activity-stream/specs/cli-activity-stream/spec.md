## ADDED Requirements

### Requirement: CLI 必须显示实时活动流
系统必须在最终 assistant answer 出现之前，向用户显示 agent 当前正在执行的高价值活动，而不是在执行期间保持沉默。

#### Scenario: 活动流在最终回答前显示
- **WHEN** agent 开始处理用户请求并在给出最终回答前经历多个执行步骤
- **THEN** CLI 必须在最终 assistant answer 之前输出一组活动流消息，帮助用户理解当前执行过程

#### Scenario: 没有活动事件时保持兼容
- **WHEN** 某次 turn 没有产生活动事件
- **THEN** CLI 必须继续保持现有输出行为，而不能因为缺少活动事件而中断或报错

### Requirement: Runtime 必须产出结构化活动事件
系统必须由 runtime 主动产出结构化活动事件，以表达思考、规划、工具执行、审批等待和模型错误等状态。

#### Scenario: 模型请求前产出思考事件
- **WHEN** runtime 即将发起一次模型请求
- **THEN** 它必须产出一个表示当前正在思考或准备下一步动作的活动事件

#### Scenario: 审批等待时产出等待事件
- **WHEN** runtime 因高风险操作进入等待审批状态
- **THEN** 它必须产出一个 `waiting_approval` 类活动事件

#### Scenario: 模型失败时产出错误事件
- **WHEN** runtime 遇到模型请求失败
- **THEN** 它必须产出一个 `model_error` 类活动事件，并让 CLI 能显示该失败状态

### Requirement: 工具执行必须显示可读活动文案
系统必须为高频工具生成可读的活动文案，让用户知道 agent 正在搜索什么、读取哪个文件或执行哪类操作。

#### Scenario: 文件读取显示路径
- **WHEN** agent 调用 `read_file` 或 `read_file_range`
- **THEN** 活动流必须显示对应文件路径，并在 `read_file_range` 情况下显示行区间

#### Scenario: 文本搜索显示查询信息
- **WHEN** agent 调用 `search_text`
- **THEN** 活动流必须显示查询关键词，并在可用时显示关键过滤信息，例如 `glob`

#### Scenario: 编辑和 shell 活动保持简洁
- **WHEN** agent 调用编辑类工具、git 工具或 `run_shell`
- **THEN** 活动流必须显示可读的动作摘要，而不是直接输出完整参数字典

### Requirement: 活动流必须与现有进度和 trace 兼容
系统必须在新增活动流的同时，继续保留现有 `progress_updates` 和 `/trace` 能力。

#### Scenario: 活动流与 progress updates 共存
- **WHEN** 某次 turn 同时产生活动事件和 `progress_updates`
- **THEN** CLI 必须能够同时渲染两者，而不会丢失任一类信息

#### Scenario: 活动流不依赖 trace 文件
- **WHEN** CLI 渲染实时活动流
- **THEN** 它必须直接消费 runtime 返回的活动事件，而不是依赖事后 trace 文件作为前台数据源
