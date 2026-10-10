import type { ClientModule } from 'claude-code'

// 膠囊按鈕：左右兩個半圓，中間填滿綠色；滑鼠移上去變亮，點一下或按 Enter 就交接
export type PillProps = { label: string }
type PillState = { isHover: boolean; isDown: boolean }

const GREEN = '#22c55e'
const GREEN_HOVER = '#4ade80'
const INK = '#052e16'

const Pill: ClientModule<PillProps, PillState> = (props, surface) => {
  const { Box, Text } = surface.elements
  const state = surface.state ?? { isHover: false, isDown: false }

  if (surface.state === undefined) {
    surface.setState(state)
    surface.onPointer(e => {
      const now = surface.state ?? state
      // 還沒排版（寬高為 0）時不判斷邊界
      const isInside =
        surface.columns === 0 || (e.x >= 0 && e.x < surface.columns && e.y >= 0 && e.y < surface.rows)
      if (e.type === 'enter') surface.setState({ ...now, isHover: true })
      if (e.type === 'leave') surface.setState({ isHover: false, isDown: false })
      if (e.type === 'down' && e.button === 'left') surface.setState({ ...now, isDown: true })
      if (e.type === 'up') {
        if (now.isDown && isInside) surface.post({ action: 'handoff' })
        surface.setState({ ...now, isDown: false })
      }
    })
    surface.onKey(e => {
      if (e.key === 'return' || e.key === ' ') surface.post({ action: 'handoff' })
    })
  }

  const fill = state.isHover || state.isDown ? GREEN_HOVER : GREEN

  return (
    <Box flexDirection="row">
      <Text color={fill}>◖</Text>
      <Text backgroundColor={fill} color={INK} bold>
        {` ${props.label} `}
      </Text>
      <Text color={fill}>◗</Text>
    </Box>
  )
}

export default Pill
