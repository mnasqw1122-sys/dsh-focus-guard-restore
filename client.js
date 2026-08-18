// FocusGuard 专注守卫 — Client 半段（v1.0.0 · rc7 兼容版）
// 目标版本：@deepseek-ai/dsh 0.1.0-rc.7
// 仓库：https://github.com/mnasqw1122-sys/dsh-focus-guard-restore
// rc7 实机核验（cordis_inspect_query，2026-08）：
// - conversation.input.dock：list 槽，注册 { name, id, order?, label? }，
//   standardProps 含 inputActions: InputActions（setDraft/submit 均在）。
// - tool.view.cordis：keyed 槽，allowedKeys 仅 'self'（Guard 绑定本包）。
// - 内置符号：React（仅 createElement，无 JSX）、host.call、styles.insert、
//   ctx.get('timer') → interval(cb, ms) 返回 disposer。
return {
  apply(ctx) {
    styles.insert(
      '.dsfg-wrap{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;line-height:1.4;padding:6px 10px;border:1px solid rgba(127,127,127,0.25);border-radius:10px;color:color-mix(in srgb,currentColor 80%,transparent);}' +
      '.dsfg-obj{font-weight:600;}' +
      '.dsfg-prog{font-variant-numeric:tabular-nums;opacity:0.85;}' +
      '.dsfg-chip{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 3px;border-radius:6px;font-size:11px;}' +
      '.dsfg-done{background:rgba(34,197,94,0.16);color:#22c55e;}' +
      '.dsfg-doing{background:rgba(59,130,246,0.16);color:#3b82f6;}' +
      '.dsfg-blocked{background:rgba(239,68,68,0.18);color:#ef4444;}' +
      '.dsfg-todo{background:rgba(127,127,127,0.14);}' +
      '.dsfg-badge{padding:1px 8px;border-radius:999px;font-weight:700;letter-spacing:0.04em;}' +
      '.dsfg-go{background:rgba(34,197,94,0.16);color:#22c55e;}' +
      '.dsfg-hold{background:rgba(245,158,11,0.18);color:#d97706;}' +
      '.dsfg-divert{background:rgba(239,68,68,0.18);color:#ef4444;}' +
      '.dsfg-blue{background:rgba(59,130,246,0.16);color:#3b82f6;}' +
      '.dsfg-card{padding:10px 12px;border-radius:10px;font-size:12.5px;line-height:1.6;border:1px solid rgba(127,127,127,0.22);}' +
      '.dsfg-card h3{margin:0 0 6px;font-size:13px;}' +
      '.dsfg-log{margin:4px 0 0;padding:0 0 0 16px;color:color-mix(in srgb,currentColor 70%,transparent);}' +
      '.dsfg-btn{font-size:11.5px;padding:2px 10px;border-radius:999px;border:1px solid rgba(127,127,127,0.35);background:rgba(127,127,127,0.08);color:inherit;cursor:pointer;line-height:1.6;}' +
      '.dsfg-btn:hover{background:rgba(127,127,127,0.16);}' +
      '.dsfg-btn-primary{background:rgba(34,197,94,0.16);border-color:rgba(34,197,94,0.4);color:#22c55e;font-weight:600;}' +
      '.dsfg-btn-primary:hover{background:rgba(34,197,94,0.26);}' +
      '.dsfg-btn-primary:disabled{opacity:0.5;cursor:default;}' +
      '.dsfg-btn-on{background:rgba(59,130,246,0.16);border-color:rgba(59,130,246,0.4);color:#3b82f6;}' +
      '.dsfg-form{flex-basis:100%;display:flex;flex-direction:column;gap:6px;padding-top:2px;}' +
      '.dsfg-ta{width:100%;min-height:56px;resize:vertical;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid rgba(127,127,127,0.35);background:rgba(127,127,127,0.06);color:inherit;font:inherit;font-size:12.5px;line-height:1.5;}' +
      '.dsfg-ta:focus{outline:none;border-color:rgba(59,130,246,0.6);}' +
      '.dsfg-form-row{display:flex;align-items:center;gap:8px;}' +
      '.dsfg-err{color:#ef4444;font-size:11.5px;}' +
      '.dsfg-hint{font-size:11px;opacity:0.7;}'
    )

    const slots = ctx.get('slots')
    if (slots === undefined) return

    slots.inject('conversation.input.dock', () => slots.register(
      { name: 'conversation.input.dock', id: 'focus-guard-bar', label: 'FocusGuard' },
      (props) => FocusBar(ctx, props),
    ))

    slots.inject('tool.view.cordis', () => slots.register(
      { name: 'tool.view.cordis', key: 'self' },
      (props) => FocusCard(ctx, props),
    ))
  },
}

function FocusBar(ctx, props) {
  // rc7: dock 的 owner share 是 { session, input }，inputActions 与 sessionId
  // 是 standardProps（session 作用域槽）；props 可能为空（槽挂载瞬间），判空。
  const inputActions = props ? props.inputActions : undefined
  const sessionId = props ? props.sessionId : undefined
  const [snap, setSnap] = React.useState(null)
  const [open, setOpen] = React.useState(false)
  const [draft, setDraft] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')

  React.useEffect(() => {
    let alive = true
    const refresh = () => {
      // 按会话寻址：多会话并行时各自显示自己的状态机。
      host.call('focus.getState', sessionId === undefined ? {} : { sessionId }).then((s) => {
        if (alive) setSnap(s)
      }).catch(() => {})
    }
    refresh()
    const timer = ctx.get('timer')
    const dispose = timer ? timer.interval(refresh, 1500) : null
    return () => {
      alive = false
      if (dispose) dispose()
    }
  }, [sessionId])

  const submit = () => {
    const text = draft.trim()
    if (text === '' || busy || sessionId === undefined) return
    setBusy(true)
    setError('')
    host.call('focus.prepareTask', { text, sessionId }).then((res) => {
      setBusy(false)
      if (res && res.ok) {
        setDraft('')
        setOpen(false)
        if (inputActions) {
          inputActions.setDraft(res.message)
          inputActions.submit()
        }
      } else {
        setError(res && res.message ? res.message : '发送失败')
      }
    }).catch(() => {
      setBusy(false)
      setError('发送失败，请重试。')
    })
  }

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  const stepMark = { done: '✓', in_progress: '▶', blocked: '⛔', pending: '○' }
  const stepClass = { done: 'dsfg-done', in_progress: 'dsfg-doing', blocked: 'dsfg-blocked', pending: 'dsfg-todo' }
  const phaseInfo = {
    thinking: { label: '🧠 思考层', cls: 'dsfg-blue' },
    planned: { label: '📋 计划已冻结', cls: 'dsfg-hold' },
    executing: { label: '⚙️ 执行层', cls: 'dsfg-go' },
    review: { label: '🔍 自审', cls: 'dsfg-hold' },
  }
  const styleInfo = {
    investigate: { label: '🔍 调查优先', cls: 'dsfg-blue' },
    produce: { label: '🏗️ 产出优先', cls: 'dsfg-go' },
  }

  let status = null
  if (snap === null) {
    status = React.createElement('span', { key: 'boot' }, '🎯 专注守卫启动中…')
  } else if (snap.active) {
    const kids = []
    const pi = phaseInfo[snap.phase]
    if (pi) kids.push(React.createElement('span', { key: 'ph', className: 'dsfg-badge ' + pi.cls }, pi.label))
    const si = styleInfo[snap.style]
    if (si) kids.push(React.createElement('span', { key: 'sty', className: 'dsfg-badge ' + si.cls }, si.label))
    kids.push(React.createElement('span', { key: 'obj', className: 'dsfg-obj' }, '🎯 ' + snap.objective))
    if (snap.phase === 'executing' || snap.phase === 'review') {
      kids.push(React.createElement('span', { key: 'prog', className: 'dsfg-prog' }, snap.phase === 'review' ? snap.reviewProgress : snap.progress))
    }
    if (snap.phase === 'executing') {
      const steps = snap.steps || []
      for (let i = 0; i < steps.length; i += 1) {
        const s = steps[i]
        kids.push(React.createElement('span', {
          key: 's' + i,
          className: 'dsfg-chip ' + (stepClass[s.status] || 'dsfg-todo'),
          title: s.text,
        }, stepMark[s.status] || '○'))
      }
    } else if (snap.phase === 'review') {
      const items = snap.reviewItems || []
      for (let i = 0; i < items.length; i += 1) {
        const r = items[i]
        const cls = r.status === 'pass' ? 'dsfg-done' : r.status === 'fail' ? 'dsfg-blocked' : 'dsfg-todo'
        const mark = r.status === 'pass' ? '✓' : r.status === 'fail' ? '✗' : '○'
        kids.push(React.createElement('span', { key: 'r' + i, className: 'dsfg-chip ' + cls, title: r.text }, mark))
      }
    }
    if (snap.flips > 0) {
      kids.push(React.createElement('span', { key: 'fl', className: 'dsfg-badge dsfg-' + (snap.flips > 2 ? 'divert' : 'hold') }, '谈判×' + snap.flips))
    }
    if (snap.lastVerdict) {
      kids.push(React.createElement('span', { key: 'v', className: 'dsfg-badge dsfg-' + snap.lastVerdict.code }, snap.lastVerdict.code.toUpperCase()))
    }
    status = kids
  } else if (snap.completed) {
    status = React.createElement('span', { key: 'done' }, '✅ 已完成并自审通过：「' + snap.objective + '」· 专注守卫待命，等待下一个任务')
  } else {
    status = React.createElement('span', { key: 'idle' }, '🎯 尚未设定专注目标 — 点「✍️ 专注任务」输入任务，自动锁定思维风格并进入思考层')
  }

  const toggleBtn = React.createElement('button', {
    key: 'toggle',
    className: 'dsfg-btn' + (open ? ' dsfg-btn-on' : ''),
    onClick: () => setOpen(!open),
  }, open ? '收起' : '✍️ 专注任务')

  const form = open ? React.createElement('div', { className: 'dsfg-form', key: 'form' },
    React.createElement('textarea', {
      className: 'dsfg-ta',
      autoFocus: true,
      value: draft,
      placeholder: '在这里输入任务…自动锁定思维风格（调查优先/产出优先）→ 思考层出计划 → 执行层照计划干 → 自动自审',
      onChange: (e) => setDraft(e.target.value),
      onKeyDown,
    }),
    React.createElement('div', { className: 'dsfg-form-row' },
      React.createElement('button', {
        className: 'dsfg-btn dsfg-btn-primary',
        onClick: submit,
        disabled: busy || draft.trim() === '',
      }, busy ? '发送中…' : '🎯 开始专注并发送'),
      React.createElement('button', {
        className: 'dsfg-btn',
        onClick: () => { setOpen(false); setError('') },
      }, '取消'),
      error !== '' ? React.createElement('span', { className: 'dsfg-err' }, error) : null,
    ),
    React.createElement('div', { className: 'dsfg-hint' }, '专注指令会自动附加到消息中，无需手动输入提示词。Enter 发送，Shift+Enter 换行。'),
  ) : null

  return React.createElement('div', { className: 'dsfg-wrap', title: 'FocusGuard 专注守卫（锚定模式）' }, status, toggleBtn, form)
}

function FocusCard(ctx, props) {
  const sessionId = props ? props.sessionId : undefined
  const [snap, setSnap] = React.useState(null)
  React.useEffect(() => {
    let alive = true
    const refresh = () => {
      // 按会话寻址：卡片显示当前会话自己的状态机。
      host.call('focus.getState', sessionId === undefined ? {} : { sessionId }).then((s) => {
        if (alive) setSnap(s)
      }).catch(() => {})
    }
    refresh()
    const timer = ctx.get('timer')
    const dispose = timer ? timer.interval(refresh, 1500) : null
    return () => {
      alive = false
      if (dispose) dispose()
    }
  }, [sessionId])

  const rows = [
    'start — 锁定思维风格（调查优先/产出优先）+ 进入思考层',
    'plan — 提交完整计划并冻结（生成恒定续链锚）',
    'execute — 切换到执行层，每轮注入同一锚点续链',
    'check — 每步前校验意图（拦谈判/拦反刍/拦越界）',
    'step — 标记步骤 done / in_progress / blocked',
    'complete → review → finalize — 自审收尾（7 项含分层纪律）',
    '锚定兜底 — 范式谈判超限由外部强制否决，模型无权再切换',
  ]
  const lis = rows.map((r, i) => React.createElement('li', { key: i }, r))

  let live = null
  if (snap && snap.phase === 'review') {
    const items = snap.reviewItems || []
    const rlis = items.map((r, i) => React.createElement('li', { key: i }, r.status + ' · ' + r.text + (r.note ? '（' + r.note + '）' : '')))
    live = React.createElement('div', { style: { marginTop: 8 } },
      React.createElement('div', null, '🔍 自审中：「' + snap.objective + '」（' + snap.reviewProgress + '）'),
      React.createElement('ul', { className: 'dsfg-log' }, rlis),
    )
  } else if (snap && snap.active) {
    const steps = snap.steps || []
    const slis = steps.map((s, i) => React.createElement('li', { key: i }, s.status + ' · ' + s.text))
    live = React.createElement('div', { style: { marginTop: 8 } },
      React.createElement('div', null, '当前目标：' + snap.objective + '（' + snap.phase + ' / ' + snap.style + ' / ' + snap.progress + ' / 谈判×' + snap.flips + '）'),
      React.createElement('ul', { className: 'dsfg-log' }, slis),
    )
  }

  return React.createElement('div', { className: 'dsfg-card' },
    React.createElement('h3', null, '🧭 专注守卫 FocusGuard 锚定模式已激活'),
    React.createElement('p', { style: { margin: '0 0 6px' } }, '单点锁定思维范式，续链锚保持轨迹恒定，外部裁决杜绝左右互搏：'),
    React.createElement('ul', { className: 'dsfg-log' }, lis),
    React.createElement('p', { style: { margin: '6px 0 0' } }, '💡 更快的方式：在输入框上方专注条点「✍️ 专注任务」，直接输入任务并发送，自动锁定风格并进入思考层。'),
    live,
  )
}
