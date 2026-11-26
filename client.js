/**
 * 「千问办公积分」角标：挂在对话输入框的 dock 里，显示当前账号的可用积分。
 *
 * 数据来自宿主插件自己的回环路由 `/plugins/dsh-qwenwork-bridge/balance`，
 * 所以这里没有任何凭据逻辑 —— 只渲染。
 *
 * 槽位名 `conversation.input.dock` 取自同版本已在运行的外部插件
 * （`@linxin666/dsh-client-ui-git-graph` 的 BranchChip），模板里的
 * `conversation.composer.dock` 在当前版本并不存在。
 */
window.__ModuleLoader__.load({
  id: 'dsh-qwenwork-bridge',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 余额多久自己重读一次（毫秒）。 */
    const REFRESH_MS = 60_000

    /** 把积分显示成两位小数，去掉多余的尾零。 */
    function formatCredits(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      const fixed = value.toFixed(2)
      // 2076.00 → 2076；2076.10 → 2076.1
      return fixed.replace(/\.0+$/, '').replace(/(\.\d)0$/, '$1')
    }

    /**
     * 积分角标。
     *
     * 状态机：`loading` → `ready` | `error`。点击强制刷新，失败时保留上一次
     * 的数值（避免一次网络抖动把界面清空）。
     */
    function BalanceChip() {
      const [state, setState] = React.useState({ phase: 'loading' })

      const load = React.useCallback(async (force) => {
        try {
          const path = `/plugins/dsh-qwenwork-bridge/balance${force === true ? '?force=1' : ''}`
          const res = await fetch(path, { cache: 'no-store' })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const body = await res.json()
          if (body.error !== undefined) {
            setState((prev) =>
              prev.phase === 'ready'
                ? { ...prev, stale: true, error: String(body.error) }
                : { phase: 'error', error: String(body.error) },
            )
            return
          }
          setState({
            phase: 'ready',
            remaining: body.quota?.remaining ?? null,
            exceeded: body.quota?.exceeded === true,
            plan: body.plan?.name ?? '',
            fetchedAtMs: body.fetchedAtMs ?? Date.now(),
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          setState((prev) =>
            prev.phase === 'ready' ? { ...prev, stale: true, error: message } : { phase: 'error', error: message },
          )
        }
      }, [])

      React.useEffect(() => {
        void load(false)
        const timer = setInterval(() => {
          void load(false)
        }, REFRESH_MS)
        return () => {
          clearInterval(timer)
        }
      }, [load])

      const label =
        state.phase === 'ready'
          ? formatCredits(state.remaining)
          : state.phase === 'error'
            ? '—'
            : '…'

      const tone = state.phase === 'ready' && state.exceeded === true ? '#d9534f' : 'inherit'
      const title =
        state.phase === 'ready'
          ? `${state.plan === '' ? '千问办公' : state.plan}｜可用积分 ${formatCredits(state.remaining)}${state.stale === true ? '（刷新失败，显示的是上一次的值）' : ''}\n点击刷新`
          : state.phase === 'error'
            ? `读取积分失败：${state.error}\n点击重试`
            : '正在读取千问办公积分…'

      return h(
        'button',
        {
          type: 'button',
          title,
          'aria-label': `千问办公可用积分 ${label}`,
          onClick: () => {
            void load(true)
          },
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '1px 8px',
            margin: 0,
            border: 'none',
            borderRadius: 999,
            background: 'transparent',
            color: tone,
            font: 'inherit',
            fontSize: 11,
            lineHeight: '18px',
            cursor: 'pointer',
            opacity: state.stale === true ? 0.55 : 0.8,
            whiteSpace: 'nowrap',
          },
        },
        h('span', { style: { opacity: 0.75 } }, '积分'),
        h('span', { style: { fontVariantNumeric: 'tabular-nums', fontWeight: 600 } }, label),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.dock', () => {
          try {
            return ctx.slots.register(
              {
                name: 'conversation.input.dock',
                id: 'qwenwork-balance',
                // 排在已有 chip（git-graph 用 100）之后，落在上下文指示器一侧。
                order: 120,
              },
              BalanceChip,
            )
          } catch {
            // 槽位不存在时静默降级：角标不出现，插件其余功能不受影响。
            return () => {}
          }
        })
      },
    }
  },
})
