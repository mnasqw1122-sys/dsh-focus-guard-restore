// FocusGuard 专注守卫 — Host 半段（v1.0.0 · rc7 兼容版）
// 目标版本：@deepseek-ai/dsh 0.1.0-rc.7（tag dsh-v0.1.0-rc.7, 99f6f02）
// 仓库：https://github.com/mnasqw1122-sys/dsh-focus-guard-restore
// rc7 契约要点：
// - 'system-prompt/assemble' 为 waterfall：签名 (assembly, context, next)，
//   next() 的返回值权威；AssembleContext 由 @deepseek-ai/dsh-agent 合并扩展，
//   回合装配时携带 agent（agent.session.id 可用），诊断装配时可能缺失（已守卫）。
// - 动态插件 Host 半挂在宿主根 fiber（非 scope 过滤），本监听会收到进程内
//   所有 agent 的装配，必须用 sessionId 过滤（见下）。
// - rc7 中 AssembledSection 只有 { name, text }，无 order 字段。
// - rc7 中若某 scope 注册了 complete 提示段（如 minimal preset 的 persona），
//   waterfall 返回后 sections 会被恢复为单一 complete 段，监听器注入的
//   focus-anchor 会被覆盖；cordis/standard/code preset 不注册 complete 段，
//   本插件不受影响（README 有说明）。
return {
  apply(ctx) {
    // 多会话隔离：每个会话一个独立状态机（focus 工具全局可见，任何会话都能
    // 起任务且互不干扰）。状态机按会话懒创建，超上限时淘汰最旧会话。
    const states = new Map()

    const createState = () => ({
      active: false,
      completed: false,
      phase: 'idle',
      style: null,
      flips: 0,
      objective: '',
      steps: [],
      exclusions: [],
      reviewItems: [],
      execAnchorBase: '',
      lastVerdict: null,
      log: [],
      // 锚通道探测（rc7 complete 段恢复）：'sections' | 'contexts' | 'none'
      anchorChannel: 'sections',
      channelDecided: false,
      probing: false,
      probePhase: null,
    })

    const stateFor = (sessionId) => {
      let s = states.get(sessionId)
      if (s === undefined) {
        if (states.size >= 64) states.delete(states.keys().next().value)
        s = createState()
        states.set(sessionId, s)
      }
      return s
    }

    const MAX_FLIPS = 2

    const REVIEW_ITEMS = [
      '需求完整性：交付物是否完整覆盖任务目标的全部步骤与要求',
      '正确性：实现或结论是否正确，无语法、逻辑或明显错误',
      '边界与健壮性：异常输入、边界条件、失败路径是否已处理',
      '实际验证：是否实际运行、测试或复现验证过，而非仅凭推理',
      '清理收尾：临时文件、调试代码、TODO、无关改动是否已清理',
      '范围检查：是否做了目标范围外的事（对照禁止范围），无跑题遗留',
      '分层纪律：思考层只思考、执行层只执行，全程无混层（边做边想、执行中另起计划均属违规）',
    ]

    const THINKING_TOOLS = ['focus', 'read', 'glob', 'grep', 'web_search', 'skill', 'read_image', 'ask_user_question']

    const THINK_ANCHOR = '🧠 思考层已锁定：只做理解与规划，禁止执行。完成调查后立即提交计划，不要反复重查同一处。'
    const PLANNED_ANCHOR = '📋 计划已冻结：不再思考、不再谈判。调用 action=execute 进入执行层。'

    const PRODUCE_RE = /开发|创建|写一个|生成|从零|做一个|游戏|网页|网站|构建|新项目|搭建|实现|做出|上线|落地|脚本|工具|应用|build|create|develop|generate|implement|make a|new project/i
    const INVEST_RE = /修复|修一下|调试|重构|维护|排查|报错|出错|崩溃|优化|审查|review|fix|debug|refactor|maintain|repair|broken|break|为什么|异常|故障|迁移|升级|兼容/i

    const asList = (value) => {
      if (Array.isArray(value)) {
        return value
          .filter((x) => typeof x === 'string' && x.trim() !== '')
          .map((x) => x.trim())
      }
      if (typeof value === 'string' && value.trim() !== '') return [value.trim()]
      return []
    }

    const containsAny = (text, phrases) => {
      const t = String(text == null ? '' : text).toLowerCase()
      const hits = []
      for (let i = 0; i < phrases.length; i += 1) {
        const q = String(phrases[i] == null ? '' : phrases[i]).toLowerCase()
        if (q !== '' && t.indexOf(q) !== -1) hits.push(phrases[i])
      }
      return hits
    }

    const countHits = (regex, text) => {
      const matches = String(text == null ? '' : text).match(regex)
      return matches ? matches.length : 0
    }

    const classifyStyle = (text) => {
      const p = countHits(PRODUCE_RE, text)
      const i = countHits(INVEST_RE, text)
      return p > i ? 'produce' : 'investigate'
    }

    const pushLog = (state, entry) => {
      state.log.push(entry)
      if (state.log.length > 30) state.log = state.log.slice(-30)
    }

    const progress = (state) => {
      if (state.steps.length === 0) return '-'
      const done = state.steps.filter((s) => s.status === 'done').length
      return done + '/' + state.steps.length
    }

    const reviewProgress = (state) => {
      if (state.reviewItems.length === 0) return '-'
      const pass = state.reviewItems.filter((r) => r.status === 'pass').length
      return pass + '/' + state.reviewItems.length
    }

    const reviewText = (state) => {
      let text = '🔍 任务主体已完成，自动进入自审自查环节。请逐项自查，并用 action=review（item=序号，status=pass/fail，可附 note）报告结果：\n'
      for (let i = 0; i < state.reviewItems.length; i += 1) {
        const r = state.reviewItems[i]
        const mark = r.status === 'pass' ? '✅' : r.status === 'fail' ? '❌' : '⬜'
        text += mark + ' ' + (i + 1) + '. ' + r.text + (r.note !== '' ? '（' + r.note + '）' : '') + '\n'
      }
      const pending = state.reviewItems.filter((r) => r.status === 'pending').length
      const failed = state.reviewItems.filter((r) => r.status === 'fail').length
      if (pending > 0) text += '还剩 ' + pending + ' 项未审。逐项 review；fail 的项必须先修复再重新 review 为 pass。'
      else if (failed > 0) text += '存在 ' + failed + ' 个 fail 项：必须先修复相关问题，再用 action=review 重新标记为 pass。'
      else text += '✅ 自审全部通过，调用 action=finalize 正式收尾。'
      return { focus: 'review', text, progress: reviewProgress(state) }
    }

    const currentStepLine = (state) => {
      const current = state.steps.find((s) => s.status !== 'done')
      if (current === undefined) return '全部步骤已完成，调用 action=complete 进入自审。'
      const idx = state.steps.indexOf(current) + 1
      return '当前第 ' + idx + '/' + state.steps.length + ' 步：' + current.text
    }

    const withAnchor = (sections, text) => {
      const list = Array.isArray(sections) ? sections : []
      const rest = list.filter((s) => s && s.name !== 'focus-anchor')
      // rc7: AssembledSection 只有 { name, text }；追加到末尾即系统提示最后一段。
      return [...rest, { name: 'focus-anchor', text }]
    }

    const withContextAnchor = (contexts, text) => {
      const list = Array.isArray(contexts) ? contexts : []
      const rest = list.filter((c) => c && c.name !== 'focus-anchor')
      return [...rest, { name: 'focus-anchor', text }]
    }

    const filterTools = (tools) => {
      const list = Array.isArray(tools) ? tools : []
      return list.filter((t) => t && THINKING_TOOLS.indexOf(t.name) !== -1)
    }

    const anchorTextFor = (state) => {
      if (state.phase === 'thinking') return THINK_ANCHOR
      if (state.phase === 'planned') return PLANNED_ANCHOR
      if (state.phase === 'executing') return state.execAnchorBase + '\n' + currentStepLine(state)
      return null
    }

    // 按选定通道注入锚；'none'（minimal 类 preset 有意屏蔽）时只保留工具隔离。
    const applyAnchor = (state, out, channel) => {
      const text = anchorTextFor(state)
      if (text === null) return out
      const restrict = state.phase === 'thinking' || state.phase === 'planned'
        ? { tools: filterTools(out.tools) }
        : {}
      if (channel === 'none') return restrict.tools === undefined ? out : { ...out, ...restrict }
      if (channel === 'contexts') {
        return { ...out, ...restrict, contexts: withContextAnchor(out.contexts, text) }
      }
      return { ...out, ...restrict, sections: withAnchor(out.sections, text) }
    }

    // rc7 通道探测：complete 段恢复发生在 waterfall 返回之后，监听器无法在注入
    // 时预知；任务激活后做一次实测——以 sections 通道注入锚再装配，锚存活即
    // sections 有效；被擦则以 contexts 通道重试；两者皆被擦（complete +
    // includeRuntimeContext:false，如 minimal preset 的设计意图）则判定 none。
    // 探测子装配会再次触发本监听器（state.probing 防重入，只注入不探测）。
    // 每个会话的状态机独立探测一次。
    const decideChannel = async (state, scope) => {
      const systemPrompt = ctx.get('systemPrompt')
      if (systemPrompt === undefined) {
        state.anchorChannel = 'sections'
        state.channelDecided = true
        return
      }
      state.probing = true
      try {
        state.probePhase = 'sections'
        const p1 = await systemPrompt.assemble({ scope })
        if (p1.sections.some((s) => s && s.name === 'focus-anchor')) {
          state.anchorChannel = 'sections'
        } else {
          state.probePhase = 'contexts'
          const p2 = await systemPrompt.assemble({ scope })
          state.anchorChannel = p2.contexts.some((c) => c && c.name === 'focus-anchor')
            ? 'contexts'
            : 'none'
        }
      } catch (err) {
        state.anchorChannel = 'sections'
      } finally {
        state.probePhase = null
        state.probing = false
        state.channelDecided = true
      }
    }

    // rc7: Host 半挂在根 fiber（非 scope 过滤），本监听收到进程内所有 agent 的
    // 装配；按 AssembleContext.agent 的 sessionId 取该会话自己的状态机，天然
    // 多会话隔离（会话之间互不干扰）。agent 在诊断装配时可能缺失（只对回合
    // 装配填充）。
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const out = await next()
      try {
        const agent = context && context.agent
        if (agent === undefined || agent.session === undefined) return out
        const state = stateFor(agent.session.id)
        // 探测子装配：按当前 probePhase 注入锚供判定，不再进入探测分支。
        if (state.probing) return applyAnchor(state, out, state.probePhase || 'sections')
        // 任务激活后的首次装配：先实测可用通道，再按结果注入（首轮即正确）。
        if (!state.channelDecided && state.active) await decideChannel(state, context.scope)
        return applyAnchor(state, out, state.channelDecided ? state.anchorChannel : 'sections')
      } catch (err) {
        return out
      }
    })

    const snapshot = (state) => ({
      active: state.active,
      completed: state.completed,
      phase: state.phase,
      style: state.style,
      flips: state.flips,
      objective: state.objective,
      progress: progress(state),
      steps: state.steps.map((s) => ({ text: s.text, status: s.status, note: s.note })),
      exclusions: state.exclusions,
      reviewItems: state.reviewItems.map((r) => ({ text: r.text, status: r.status, note: r.note })),
      reviewProgress: reviewProgress(state),
      lastVerdict: state.lastVerdict,
      anchorChannel: state.channelDecided ? state.anchorChannel : 'pending',
      log: state.log.slice(-5),
    })

    // rc7: harness.defineTool 由 cordis-host-runner 的 guard 校验——
    // parameters 用 DSL（属性级 required: true / enum / array items / integer），
    // output.schema 用 ValueSchemaSpec（对象必须显式 additionalProperties），
    // render 必须返回 ContentBlock 数组，execute 返回值必须是 lossless JSON 且
    // 会被 output.schema 校验（本工具所有返回分支都含 focus+text 字符串）。
    const focusTool = harness.defineTool({
      name: 'focus',
      description: '专注守卫 (FocusGuard) 锚定模式：单点锁定思维范式，杜绝左右互搏。流程：1) action=start（objective=一句话目标，可选 style=investigate/produce 覆盖自动分类）——按任务类型锁定思维风格：修 bug/维护→调查优先（每步先核实再改），新开发/构建→产出优先（直接产出然后验证）；整场锁定不换。2) 思考层只做理解与规划（写入/执行类工具被系统禁用），完成后 action=plan 提交完整计划（steps 每步含执行逻辑与验收标准）并冻结，生成恒定续链锚。3) action=execute 进入执行层——每轮注入同一锚点续链（计划已冻结+当前第 N 步），不重新规划、不边做边想；每步前 action=check 校验意图：GO=当前步骤一致；HOLD=想跳步/关联不明；DIVERT=触犯禁止范围。禁止范式谈判与反刍：重新规划/自我怀疑意图会被拦截，谈判超过 2 次由外部强制否决，模型无权再切换。4) action=step 标记进度；blocked 如实报告，交用户决定。5) 全部步骤完成后 action=complete 进入 7 项强制自审，全部 pass 后 action=finalize 收尾。',
      parameters: {
        action: { type: 'string', required: true, enum: ['start', 'plan', 'execute', 'check', 'step', 'note', 'report', 'complete', 'review', 'finalize'], description: '要执行的操作。' },
        objective: { type: 'string', description: 'start 必填：当前任务的一句话目标。' },
        style: { type: 'string', enum: ['investigate', 'produce'], description: 'start 时可选：强制锁定思维风格；不填则按任务类型自动分类。' },
        steps: { type: 'array', items: { type: 'string' }, description: 'plan 必填：完整执行计划；每一步的 text 必须包含执行逻辑与验收标准。' },
        exclusions: { type: 'array', items: { type: 'string' }, description: 'plan 时提供：明确禁止做或无关的范围/话题。' },
        intention: { type: 'string', description: 'check 必填：你接下来打算执行的动作或子任务。' },
        index: { type: 'integer', description: 'step 必填：步骤序号，从 1 开始。' },
        item: { type: 'integer', description: 'review 必填：自审清单序号，从 1 开始。' },
        status: { type: 'string', enum: ['done', 'in_progress', 'blocked', 'pending', 'pass', 'fail'], description: 'step 时用 done/in_progress/blocked/pending；review 时用 pass/fail。' },
        note: { type: 'string', description: 'step/note/review 时提供：附注或记录。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            focus: { type: 'string', required: true },
            text: { type: 'string', required: true },
            progress: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      execute: async (args, exec) => {
        // rc7: ToolRunContext.agent 由 agent loop 注入（工具调用必有）；按调用
        // 会话取独立状态机——多会话并行互不干扰（本函数内 state 即会话状态机）。
        const callerAgent = exec && exec.agent
        const state = callerAgent !== undefined && callerAgent.session !== undefined
          ? stateFor(callerAgent.session.id)
          : stateFor('__unknown__')
        const action = args && typeof args.action === 'string' ? args.action : 'report'

        if (action === 'start') {
          const objective = typeof args.objective === 'string' ? args.objective.trim() : ''
          if (objective === '') {
            return { focus: 'error', text: '❌ start 缺少 objective：请用一句话声明本任务的唯一目标。' }
          }
          state.objective = objective
          state.style = args.style === 'produce' || args.style === 'investigate' ? args.style : classifyStyle(objective)
          state.steps = []
          state.exclusions = []
          state.flips = 0
          state.active = true
          state.completed = false
          state.phase = 'thinking'
          state.reviewItems = []
          state.execAnchorBase = ''
          state.lastVerdict = null
          pushLog(state, { kind: 'start', objective, style: state.style })
          const styleLabel = state.style === 'produce' ? '🏗️ 产出优先（直接产出→验证）' : '🔍 调查优先（先核实→再修改）'
          return { focus: 'thinking', text: '🧠 进入思考层：「' + objective + '」\n思维风格已锁定：' + styleLabel + '——整场任务不再切换。\n本层职责：只做理解、调查与规划（写入/执行类工具已被系统禁用，勿反复重查同一处）；每一步计划写明执行逻辑与验收标准。\n计划完成后调用 action=plan 提交并冻结。', progress: progress(state) }
        }

        if (action === 'plan') {
          if (state.phase !== 'thinking' && state.phase !== 'planned' && state.phase !== 'executing') {
            return { focus: 'error', text: '❌ 先 action=start 进入思考层，再提交计划。' }
          }
          if (state.phase === 'executing') {
            state.flips += 1
            if (state.flips > MAX_FLIPS) {
              pushLog(state, { kind: 'veto', flips: state.flips })
              return { focus: 'divert', text: '🔴 外部锚定裁决：范式已锁定，谈判次数 ' + state.flips + ' 已超限（' + MAX_FLIPS + '）。修订请求被否决——继续按当前冻结计划执行；卡住就把当前步骤标记为 blocked，交由用户决定。' }
            }
          }
          const steps = asList(args.steps).slice(0, 30)
          if (steps.length === 0) {
            return { focus: 'error', text: '❌ plan 需要 steps：完整执行计划，每步含执行逻辑与验收标准。' }
          }
          const revised = state.phase === 'executing'
          state.steps = steps.map((t) => ({ text: t, status: 'pending', note: '' }))
          state.exclusions = asList(args.exclusions)
          state.phase = 'planned'
          state.lastVerdict = null
          state.execAnchorBase = '⚙️ 执行层已锁定（风格：' + (state.style === 'produce' ? '产出优先：直接产出然后验证' : '调查优先：每步先核实再修改') + '）：按冻结计划直接执行，不重新规划、不自我怀疑、不做计划外的事。'
          pushLog(state, { kind: 'plan', steps: steps.length, revised, flips: state.flips })
          let text = (revised ? '📝 计划已修订并重新冻结（谈判 ' + state.flips + '/' + MAX_FLIPS + '，仅剩 ' + (MAX_FLIPS - state.flips + 1) + ' 次机会）。' : '📋 计划已冻结。') + '共 ' + steps.length + ' 步：\n'
          for (let i = 0; i < steps.length; i += 1) text += '  ' + (i + 1) + '. ' + steps[i] + '\n'
          if (state.exclusions.length > 0) text += '🚫 禁止范围：' + state.exclusions.join('；') + '\n'
          text += '思考层完成。调用 action=execute 切换到执行层，直接照此计划执行。'
          return { focus: 'planned', text, progress: progress(state) }
        }

        if (action === 'execute') {
          if (state.phase !== 'planned') {
            return { focus: 'error', text: '❌ 计划尚未冻结：先 action=plan 提交完整计划，再进入执行层。' }
          }
          if (state.steps.length === 0) {
            return { focus: 'error', text: '❌ 计划为空，先 action=plan。' }
          }
          state.phase = 'executing'
          pushLog(state, { kind: 'execute' })
          let text = '⚙️ 进入执行层：计划已冻结，直接执行。\n纪律：只做计划内的事；不重新规划、不边做边想、不反复自我怀疑；一次只推进一个步骤。\n'
          text += currentStepLine(state) + '\n开始前先 action=check 校验意图。'
          return { focus: 'executing', text, progress: progress(state) }
        }

        if (action === 'check') {
          if (!state.active) {
            return { focus: 'none', text: '⚠️ 尚未设置专注目标。先用 action=start 锁定目标与风格并进入思考层。' }
          }
          const intention = typeof args.intention === 'string' ? args.intention.trim() : ''
          if (intention === '') {
            return { focus: 'hold', text: '🟡 HOLD：check 需要 intention——请说明你接下来打算做什么。' }
          }
          const exHits = containsAny(intention, state.exclusions)
          if (exHits.length > 0) {
            state.lastVerdict = { code: 'divert', intention: intention.slice(0, 80) }
            pushLog(state, { kind: 'check', code: 'divert', intention: intention.slice(0, 80) })
            return { focus: 'divert', text: '🔴 DIVERT：意图触犯禁止范围（' + exHits.slice(0, 3).join('、') + '）。立即停止该动作。只有用户明确要求扩展范围时才允许。' }
          }
          if (state.phase === 'thinking') {
            const execHits = containsAny(intention, ['修改', '写入', '编辑', '运行', '执行', '删除', '安装', '部署', '实现', '重构', '写文件', '写代码', '生成文件', '保存'])
            const readHits = containsAny(intention, ['读取', '查看', '搜索', '检查', '了解', '分析', '梳理', '调查', '研究', '确认', '查阅', '阅读'])
            if (execHits.length > 0) {
              state.lastVerdict = { code: 'divert', intention: intention.slice(0, 80) }
              pushLog(state, { kind: 'check', code: 'divert', intention: intention.slice(0, 80) })
              return { focus: 'divert', text: '🔴 DIVERT：思考层禁止执行（意图含：' + execHits.slice(0, 3).join('、') + '）。本层只做理解与规划；先完成调查并提交计划，再进入执行层。' }
            }
            if (readHits.length > 0) {
              state.lastVerdict = { code: 'go', intention: intention.slice(0, 80) }
              pushLog(state, { kind: 'check', code: 'go', intention: intention.slice(0, 80) })
              return { focus: 'go', text: '🟢 GO：只读调查，符合思考层职责。调查充分后立即 action=plan 提交完整计划。' }
            }
            state.lastVerdict = { code: 'hold', intention: intention.slice(0, 80) }
            pushLog(state, { kind: 'check', code: 'hold', intention: intention.slice(0, 80) })
            return { focus: 'hold', text: '🟡 HOLD：思考层内该意图关联不明。确认它是理解/规划所必需的调查吗？不是就放弃，尽快收敛到计划上。' }
          }
          if (state.phase === 'planned') {
            state.lastVerdict = { code: 'hold', intention: intention.slice(0, 80) }
            pushLog(state, { kind: 'check', code: 'hold', intention: intention.slice(0, 80) })
            return { focus: 'hold', text: '🟡 HOLD：计划已冻结。不要继续思考也不要开始动手——调用 action=execute 切换到执行层。' }
          }
          if (state.phase === 'executing') {
            const current = state.steps.find((s) => s.status !== 'done')
            if (current === undefined) {
              return { focus: 'go', text: '🟢 所有步骤已完成。调用 action=complete 进入自审自查环节。' }
            }
            const idx = state.steps.indexOf(current) + 1
            const negoHits = containsAny(intention, ['重新计划', '重新规划', '调整计划', '换个思路', '重新设计', '另起计划', '重新思考', '改方案', '推翻计划', '重新安排'])
            if (negoHits.length > 0) {
              state.flips += 1
              if (state.flips > MAX_FLIPS) {
                state.lastVerdict = { code: 'divert', intention: intention.slice(0, 80) }
                pushLog(state, { kind: 'check', code: 'divert', intention: intention.slice(0, 80) })
                return { focus: 'divert', text: '🔴 外部锚定裁决：谈判 ' + state.flips + ' 次已超限（' + MAX_FLIPS + '）。禁止再切换范式——继续执行当前步骤 ' + idx + '；卡住就标记 blocked 交用户决定。' }
              }
              state.lastVerdict = { code: 'hold', intention: intention.slice(0, 80) }
              pushLog(state, { kind: 'check', code: 'hold', intention: intention.slice(0, 80) })
              return { focus: 'hold', text: '🟡 HOLD：检测到范式谈判（' + state.flips + '/' + MAX_FLIPS + '）。执行层不谈判：继续当前步骤 ' + idx + '。仅剩 ' + (MAX_FLIPS - state.flips + 1) + ' 次修订机会，之后将被外部强制否决。' }
            }
            const rumiHits = containsAny(intention, ['再确认', '再次确认', '重新检查', '又看一遍', '再查一遍', '是否应该', '我是不是', '要不要重新', '反复确认', '再想一下'])
            if (rumiHits.length > 0) {
              state.lastVerdict = { code: 'hold', intention: intention.slice(0, 80) }
              pushLog(state, { kind: 'check', code: 'hold', intention: intention.slice(0, 80) })
              return { focus: 'hold', text: '🟡 反刍抑制：不要反复自我怀疑或重查环境。信任已完成的步骤，直接继续当前步骤 ' + idx + '。' }
            }
            const okHits = containsAny(intention, [current.text])
            const otherHits = containsAny(intention, state.steps.map((s) => s.text))
            if (okHits.length > 0) {
              state.lastVerdict = { code: 'go', intention: intention.slice(0, 80) }
              pushLog(state, { kind: 'check', code: 'go', intention: intention.slice(0, 80) })
              return { focus: 'go', text: '🟢 GO：意图与当前步骤 ' + idx + '/' + state.steps.length + ' 一致。直接执行这一步，完成后 action=step 标记并进入下一步。', progress: progress(state) }
            }
            if (otherHits.length > 0) {
              state.lastVerdict = { code: 'hold', intention: intention.slice(0, 80) }
              pushLog(state, { kind: 'check', code: 'hold', intention: intention.slice(0, 80) })
              return { focus: 'hold', text: '🟡 HOLD：意图属于计划的其他步骤，不是当前步骤 ' + idx + '。执行层一次只做当前步；做完当前步再推进。' }
            }
            state.lastVerdict = { code: 'hold', intention: intention.slice(0, 80) }
            pushLog(state, { kind: 'check', code: 'hold', intention: intention.slice(0, 80) })
            return { focus: 'hold', text: '🟡 HOLD：意图与当前步骤 ' + idx + ' 关联不明。执行层不做计划外的事。' }
          }
          state.lastVerdict = { code: 'hold', intention: intention.slice(0, 80) }
          return { focus: 'hold', text: '🟡 HOLD：意图与当前阶段关联不明。' }
        }

        if (action === 'step') {
          if (!state.active) return { focus: 'error', text: '❌ 还没有专注目标，先 action=start。' }
          if (state.phase !== 'executing') return { focus: 'error', text: '❌ 执行层之外不能标记步骤：先 action=execute 进入执行层。' }
          const idx = Number(args.index)
          if (!Number.isInteger(idx) || idx < 1 || idx > state.steps.length) {
            return { focus: 'error', text: '❌ index 必须是 1~' + state.steps.length + ' 的整数。' }
          }
          const status = ['done', 'in_progress', 'blocked', 'pending'].indexOf(args.status) !== -1 ? args.status : 'pending'
          const note = typeof args.note === 'string' ? args.note.trim() : ''
          state.steps[idx - 1].status = status
          if (note !== '') state.steps[idx - 1].note = note
          pushLog(state, { kind: 'step', index: idx, status, note })
          const remain = state.steps.filter((s) => s.status !== 'done')
          let text = '步骤 ' + idx + '/' + state.steps.length + ' → ' + status + (note !== '' ? '（' + note + '）' : '') + '。'
          if (status === 'blocked') {
            text += '⛔ 执行层职责：如实报告阻塞，不自行另起计划。交由用户决定下一步。'
          } else if (remain.length > 0) {
            text += '下一个焦点：' + remain[0].text + '。开始前先 action=check 校验意图。'
          } else {
            text += '✅ 全部步骤已完成。调用 action=complete 进入自审自查环节。'
          }
          return { focus: 'step', text, progress: progress(state) }
        }

        if (action === 'note') {
          const note = typeof args.note === 'string' ? args.note.trim() : ''
          if (note === '') return { focus: 'error', text: '❌ note 需要内容。' }
          pushLog(state, { kind: 'note', note: note.slice(0, 200) })
          return { focus: 'noted', text: '📝 已记录笔记：' + note.slice(0, 200) }
        }

        if (action === 'report') {
          if (!state.active) {
            return { focus: 'none', text: '⚠️ 当前没有活跃的专注目标。开始新任务时先调用 action=start。' }
          }
          const phaseLabel = { thinking: '🧠 思考层', planned: '📋 计划已冻结', executing: '⚙️ 执行层', review: '🔍 自审' }[state.phase] || state.phase
          const styleLabel = state.style === 'produce' ? '🏗️ 产出优先' : '🔍 调查优先'
          let text = '🎯 目标：「' + state.objective + '」 阶段：' + phaseLabel + ' 风格：' + styleLabel + ' 谈判：' + state.flips + '/' + MAX_FLIPS + ' 进度 ' + progress(state) + '\n'
          for (let i = 0; i < state.steps.length; i += 1) {
            const s = state.steps[i]
            const mark = s.status === 'done' ? '✅' : s.status === 'in_progress' ? '🔵' : s.status === 'blocked' ? '⛔' : '⬜'
            text += mark + ' ' + (i + 1) + '. ' + s.text + (s.note !== '' ? '（' + s.note + '）' : '') + '\n'
          }
          if (state.lastVerdict) text += '最近意图判定：' + state.lastVerdict.code + '\n'
          if (state.flips > MAX_FLIPS) text += '⛔ 范式谈判已超限，外部裁决接管：继续当前计划，不得再切换。\n'
          if (state.phase === 'review') {
            text += '\n' + reviewText(state).text
            return { focus: 'review', text, progress: reviewProgress(state) }
          }
          if (state.phase === 'thinking') text += '🧠 当前在思考层：完成调查后 action=plan 提交计划。'
          else if (state.phase === 'planned') text += '📋 计划已冻结：调用 action=execute 进入执行层。'
          else {
            const undone = state.steps.filter((s) => s.status !== 'done')
            if (undone.length > 0) text += '⚠️ 还有 ' + undone.length + ' 个步骤未完成。执行层继续按计划执行，或明确标记 blocked 并说明原因。'
            else text += '✅ 所有步骤已完成，调用 action=complete 进入自审自查环节。'
          }
          return { focus: 'active', text, progress: progress(state) }
        }

        if (action === 'complete') {
          if (!state.active) return { focus: 'error', text: '❌ 没有进行中的目标。' }
          if (state.phase === 'review') return reviewText(state)
          if (state.phase !== 'executing') return { focus: 'error', text: '❌ 执行层之外不能收尾：先完成计划并 action=execute 推进。' }
          const undone = state.steps.filter((s) => s.status !== 'done')
          if (undone.length > 0) {
            return {
              focus: 'complete',
              text: '⛔ 收尾警告：还有 ' + undone.length + ' 个步骤未完成（' + undone.map((s) => s.text).join('、') + '）。执行层先做完，或把每项标记为 blocked 并写明原因。',
            }
          }
          state.phase = 'review'
          state.reviewItems = REVIEW_ITEMS.map((t) => ({ text: t, status: 'pending', note: '' }))
          pushLog(state, { kind: 'review-start', objective: state.objective })
          return reviewText(state)
        }

        if (action === 'review') {
          if (state.phase !== 'review') {
            return { focus: 'error', text: '❌ 当前不在自审环节。先完成所有步骤并调用 action=complete 进入自审。' }
          }
          const idx = Number(args.item)
          if (!Number.isInteger(idx) || idx < 1 || idx > state.reviewItems.length) {
            return { focus: 'error', text: '❌ item 必须是 1~' + state.reviewItems.length + ' 的整数（对应自审清单序号）。' }
          }
          const status = args.status === 'pass' || args.status === 'fail' ? args.status : 'pending'
          const note = typeof args.note === 'string' ? args.note.trim() : ''
          state.reviewItems[idx - 1].status = status
          if (note !== '') state.reviewItems[idx - 1].note = note
          pushLog(state, { kind: 'review', item: idx, status, note })
          if (status === 'fail') {
            return { focus: 'review', text: '❌ 第 ' + idx + ' 项自审不通过（' + state.reviewItems[idx - 1].text + '）。立即定位并修复问题，然后重新 action=review 把该项标记为 pass。\n' + reviewText(state).text, progress: reviewProgress(state) }
          }
          return reviewText(state)
        }

        if (action === 'finalize') {
          if (state.phase !== 'review') {
            return { focus: 'error', text: '❌ 还没有进入自审环节：先完成全部步骤，用 action=complete 进入自审，全部项目 pass 后才能 finalize。' }
          }
          const fail = state.reviewItems.filter((r) => r.status === 'fail')
          const pending = state.reviewItems.filter((r) => r.status === 'pending')
          if (fail.length > 0 || pending.length > 0) {
            return { focus: 'error', text: '⛔ 不能收尾：自审未通过（fail ' + fail.length + ' 项，未审 ' + pending.length + ' 项）。请完成全部 review 项为 pass 后再 finalize。' }
          }
          pushLog(state, { kind: 'finalize', objective: state.objective, flips: state.flips })
          state.completed = true
          state.active = false
          state.phase = 'idle'
          state.lastVerdict = null
          return { focus: 'complete', text: '✅ 目标完成：「' + state.objective + '」。步骤全部完成且自审全部通过（含分层纪律检查）。请简要总结交付物、验证方式与自审结论，然后结束本轮。' }
        }

        return { focus: 'error', text: '❌ 未知 action：「' + action + '」。可选：start / plan / execute / check / step / note / report / complete / review / finalize。' }
      },
    })

    harness.registerTool(ctx, focusTool)
    // RPC 为按会话寻址：Client 侧从槽 props 的 sessionId 传入（两个槽都是
    // session 作用域，standardProps 含 sessionId）。无 sessionId 时 getState
    // 返回 null、prepareTask 拒绝——不猜测会话。
    ctx.effect(() => harness.handle('focus.getState', async (args) => {
      const sid = args && typeof args.sessionId === 'string' ? args.sessionId : null
      if (sid === null) return null
      return snapshot(stateFor(sid))
    }))
    ctx.effect(() => harness.handle('focus.prepareTask', async (args) => {
      const sid = args && typeof args.sessionId === 'string' ? args.sessionId : null
      if (sid === null) return { ok: false, message: '缺少 sessionId：Client 必须从会话槽传入。' }
      const state = stateFor(sid)
      const text = typeof (args && args.text) === 'string' ? args.text.trim() : ''
      if (text === '') return { ok: false, message: '任务内容不能为空。' }
      const objective = text.length > 120 ? text.slice(0, 120) : text
      state.objective = objective
      state.style = classifyStyle(text)
      state.steps = []
      state.exclusions = []
      state.flips = 0
      state.active = true
      state.completed = false
      state.phase = 'thinking'
      state.reviewItems = []
      state.execAnchorBase = ''
      state.lastVerdict = null
      pushLog(state, { kind: 'submit', objective, style: state.style })
      const styleLabel = state.style === 'produce' ? '🏗️ 产出优先' : '🔍 调查优先'
      const message = '[FocusGuard 锚定专注模式]\n请按以下锚定纪律执行（思维风格已锁定：' + styleLabel + '，整场不再切换）：\n1) 先调用 focus 工具 action=start 确认锁定并进入思考层：只做理解与规划（read/glob/grep/web_search 等只读调查，写入与执行类工具已被禁用，勿反复重查），产出完整执行计划——每一步写明执行逻辑与验收标准。\n2) 调查完成后 action=plan 提交计划（冻结，生成恒定续链锚），然后 action=execute 切换到执行层：每轮照同一锚点续链执行——不重新规划、不自我怀疑、不做计划外的事，每步开始前 action=check 校验，做完 action=step 标记。\n3) 禁止范式谈判与反刍：重新规划/反复确认会被拦截，谈判超过 2 次由外部强制否决。\n4) 全部步骤完成后 action=complete 进入自审（7 项，含分层纪律），全部 pass 后 action=finalize 收尾。\n\n任务：\n' + text
      return { ok: true, message }
    }))
  },
}
