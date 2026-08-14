/**
 * 放置逻辑改编自 Project AIRI（MIT）：
 *   https://github.com/moeru-ai/airi/blob/main/integrations/minecraft/src/skills/blocks.ts
 *   commit f7212965da827b8bef9a1fa0ab6417c030361284
 *
 * 本地适配：
 *   - 移除 cheats/creative（/setblock、创造背包）路径，仅保留生存放置；
 *   - 移动用 pathfinder.goto（过近躲避）与 patchedGoto（>4.5 格接近）；
 *   - 保留"空方块可穿越"（草丛/植物会被放置顶掉）与"目标被占用先敲掉"语义；
 *   - 面向：placeOn 'bottom'=放在下方方块顶上（地面），'top'=贴天花板，'side'=贴墙；
 *     preferredDir 可固定首选朝向。
 */
import { goals } from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import { patchedGoto } from './patchedGoto'

export type PlaceFace = 'top' | 'bottom' | 'side'

export interface PlaceResult {
  placed: any
  cleared: boolean
}

const EMPTY_BLOCK_NAMES = new Set([
  'air', 'cave_air', 'void_air', 'water', 'lava',
  'grass', 'short_grass', 'tall_grass', 'tallgrass', 'fern', 'double_plant',
  'dead_bush', 'snow', 'snow_layer',
  'red_flower', 'yellow_flower', 'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'oxeye_daisy',
])

/**
 * 判断一个方块是否“可被放置替换”（空气、植物、薄层雪等）。
 *
 * 不能只按名字判断：旧版本（如 1.11.2）里 `grass` 是实心草方块
 * （boundingBox === 'block'），而 1.13+ 才把实心方块改名为 `grass_block`。
 * 因此以碰撞盒为准：实心方块永远不可被放置替换；只有非实心（植物/空气/水）
 * 或雪层这类可被顶掉的薄方块才可替换。
 *
 * 单元测试里的假方块没有 boundingBox，此时回退到名字表，保持原有行为。
 */
export function isReplaceableForPlacement(block: any): boolean {
  if (!block) return false
  if (typeof block.boundingBox === 'string') {
    if (block.boundingBox !== 'block') return true
    // 薄雪层（snow_layer）在旧版本数据里被标成 block，但游戏里可被放置顶掉；
    // 'snow' 在 1.8-1.16 是实心雪块，不可替换（1.20+ 的薄雪叫 'snow'，其
    // boundingBox 已经是 empty，走上面的分支即可）。
    return block.name === 'snow_layer'
  }
  return EMPTY_BLOCK_NAMES.has(block.name)
}

const NO_MOVE_AWAY_BLOCKS = new Set([
  'torch', 'redstone_torch', 'lever', 'stone_button', 'wooden_button',
  'rail', 'detector_rail', 'powered_rail', 'activator_rail',
  'tripwire_hook', 'tripwire', 'ladder', 'water_bucket',
])

const DIRS: Record<string, Vec3> = {
  top: new Vec3(0, 1, 0),
  bottom: new Vec3(0, -1, 0),
  north: new Vec3(0, 0, -1),
  south: new Vec3(0, 0, 1),
  west: new Vec3(-1, 0, 0),
  east: new Vec3(1, 0, 0),
}

export async function placeBlockAt(
  current: any,
  item: any,
  target: Vec3,
  placeOn: PlaceFace = 'bottom',
  options: { preferredDir?: Vec3; signal?: AbortSignal } = {},
): Promise<PlaceResult> {
  const blockName = item.name
  let cleared = false

  // 目标被占用：先敲掉（AIRI clearBlockSpace）
  const targetBlock = current.blockAt(target)
  if (targetBlock && !isReplaceableForPlacement(targetBlock)) {
    await breakBlockAt(current, target, options.signal)
    cleared = true
  }

  const spot = findPlacementSpot(current, target, placeOn, options.preferredDir)
  if (!spot) {
    throw new Error(`cannot place ${blockName} at ${target.toString()}: nothing to place on`)
  }

  await moveIntoPosition(current, blockName, target, options.signal)
  await tryPlaceBlock(current, item, spot.buildOffBlock, spot.faceVec, options.signal)
  return { placed: current.blockAt(target), cleared }
}

function findPlacementSpot(
  current: any,
  target: Vec3,
  placeOn: PlaceFace,
  preferredDir?: Vec3,
): { buildOffBlock: any; faceVec: Vec3 } | null {
  // preferredDir = 从参考方块指向目标的方向；放置参考 = target - preferredDir
  const dirs = preferredDir
    ? [preferredDir.scaled(-1)]
    : placeOn === 'side'
      ? [DIRS.north, DIRS.south, DIRS.east, DIRS.west, DIRS.top, DIRS.bottom]
      : [DIRS[placeOn], ...Object.values(DIRS).filter((dir) => dir !== DIRS[placeOn])]
  for (const dir of dirs) {
    const block = current.blockAt(target.plus(dir))
    if (block && !isReplaceableForPlacement(block)) {
      return { buildOffBlock: block, faceVec: dir.scaled(-1) }
    }
  }
  return null
}

async function moveIntoPosition(current: any, blockName: string, target: Vec3, signal?: AbortSignal): Promise<void> {
  const pos = current.entity?.position
  if (!pos) return
  const tooClose = distance(pos, target) < 1 || (typeof pos.offset === 'function' && distance(pos.offset(0, 1, 0), target) < 1)
  if (tooClose && !NO_MOVE_AWAY_BLOCKS.has(blockName)) {
    // 过近躲避（AIRI moveAwayFromBlock）
    await current.pathfinder.goto(new goals.GoalInvert(new goals.GoalNear(target.x, target.y, target.z, 2)))
    throwIfAborted(signal)
  }
  if (distance(current.entity.position, target) > 4.5) {
    // 太远走进（AIRI moveToBlock）
    await patchedGoto(current, new goals.GoalNear(target.x, target.y, target.z, 4), { signal })
  }
}

export async function breakBlockAt(current: any, target: Vec3, signal?: AbortSignal): Promise<void> {
  if (distance(current.entity?.position, target) > 4.5) {
    await patchedGoto(current, new goals.GoalNear(target.x, target.y, target.z, 4), { signal })
  }
  const block = current.blockAt(target)
  if (block && !isReplaceableForPlacement(block)) {
    await current.dig(block, true)
    await sleep(200, signal)
  }
}

async function tryPlaceBlock(
  current: any,
  item: any,
  buildOffBlock: any,
  faceVec: Vec3,
  signal?: AbortSignal,
): Promise<void> {
  await current.equip(item, 'hand')
  await current.lookAt(buildOffBlock.position)
  await current.placeBlock(buildOffBlock, faceVec)
  await sleep(200, signal)
}

function distance(left: any, right: any): number {
  if (!left || !right) return Number.POSITIVE_INFINITY
  if (typeof left.distanceTo === 'function') return left.distanceTo(right)
  const x = Number(left.x ?? 0) - Number(right.x ?? 0)
  const y = Number(left.y ?? 0) - Number(right.y ?? 0)
  const z = Number(left.z ?? 0) - Number(right.z ?? 0)
  return Math.sqrt(x * x + y * y + z * z)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

function abortError(): Error {
  const error = new Error('Minecraft place cancelled')
  error.name = 'AbortError'
  return error
}
