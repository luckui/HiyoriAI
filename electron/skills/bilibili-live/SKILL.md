---
name: bilibili-live
description: B站直播连接、弹幕处理与互动回复的完整工作流程，包含启动、监控和关闭步骤
version: 1.1.0
---

# B站直播管理工作流

管理 B站直播连接、弹幕接收与 AI 互动回复的标准操作流程。

## 工具对应关系

| 操作 | 工具 |
|------|------|
| 启动/停止/监控直播 | `manage_bilibili_live` |
| 管理 TTS 语音 | `manage_tts` |
| 管理听觉（语音识别） | `manage_hearing` |

> ⚠️ `watch_bilibili_video` 是看**视频**（BV/AV号）的工具，与直播无关，不要用它管理直播。

## 标准工作流

### 1. 启动直播会话

```
manage_bilibili_live(action="start", room_id=<房间号>, topic="本场主题")
```

- `room_id`：直播间房间号，如 live.bilibili.com/26835777 中的 26835777
- `topic`：本场直播主题，用于引导弹幕回复风格
- 缺少 `room_id` 时工具会自动暂停并要求向用户询问
- 首次启动需要提供 B 站 Cookie（工具会在缺失时要求询问）
- Cookie 仅本次临时使用，不会写入文件或记忆

### 2. 检查当前状态

```
manage_bilibili_live(action="status")
```

返回当前会话状态、弹幕池、已处理事件数等。

### 3. 查看最近回复记录

```
manage_bilibili_live(action="replies", limit=10)
```

### 4. 手动触发一次弹幕回复规划

```
manage_bilibili_live(action="flush")
```

### 5. 实时调整配置（无需重启）

```
manage_bilibili_live(action="update_config", idle_threshold_ms=60000, auto_tts=true)
manage_bilibili_live(action="set_topic", topic="新主题")
manage_bilibili_live(action="set_auto_reply", enabled=false)
```

### 6. 停止直播会话

```
manage_bilibili_live(action="stop")
```

### 7. 注入测试事件（调试用）

```
manage_bilibili_live(action="ingest_test", event_type="danmu", uname="测试用户", text="你好")
```

## TTS 与听觉管理

### 启用/禁用 TTS

```
manage_tts(action="set_enabled", enabled=true)   # 开启语音播报
manage_tts(action="set_enabled", enabled=false)  # 关闭语音播报
manage_tts(action="status")                      # 查看当前状态
```

### 听觉（语音识别）

```
manage_hearing(action="listen")   # 开始麦克风监听
manage_hearing(action="stop")     # 停止监听
manage_hearing(action="status")   # 查看状态
manage_hearing(action="read")     # 读取最近转录内容
```

## 注意事项

- Cookie 只在本次 start 调用中临时持有，直播停止后自动丢弃，禁止写入文件/记忆/日志
- TTS 播放时语音识别会自动暂停，避免自说自话
- 暗场阈值（`idle_threshold_ms`）控制 AI 主动发言频率，可用 `update_config` 实时调整
