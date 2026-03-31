# WeFlow HTTP API / Push 文档

WeFlow 提供本地 HTTP API（已支持GET 和 POST请求），便于外部脚本或工具读取聊天记录、会话、联系人、群成员和导出的媒体文件；也支持在检测到新消息后通过固定 SSE 地址主动推送消息事件。

## 启用方式

在应用设置页启用 `API 服务`。

- 默认监听地址：`127.0.0.1`
- 默认端口：`5031`
- 基础地址：`http://127.0.0.1:5031`
- 可选开启 `主动推送`，检测到新收到的消息后会通过 `GET /api/v1/push/messages` 推送给 SSE 订阅端

**状态记忆**：API 服务和主动推送的状态及端口会自动保存，重启 WeFlow 后会自动恢复运行。

## 鉴权规范

**鉴权规范 (Access Token)** 除健康检查接口外，所有 `/api/v1/*` 接口均受 Token 保护。支持三种传参方式（任选其一）：

1. **HTTP Header (推荐)**: `Authorization: Bearer <您的Token>`
2. **Query 参数**: `?access_token=<您的Token>`（SSE 长连接推荐此方式）
3. **JSON Body**: `{"access_token": "<您的Token>"}`（仅限 POST 请求）

## 接口列表

- `GET|POST /health`
- `GET|POST /api/v1/health`
- `GET|POST /api/v1/push/messages`
- `GET|POST /api/v1/messages`
- `GET|POST /api/v1/messages/new`
- `GET|POST /api/v1/sessions`
- `GET|POST /api/v1/contacts`
- `GET|POST /api/v1/group-members`
- `GET|POST /api/v1/media/*`

---

## 1. 健康检查

**请求**

```http
GET /health
```

或

```http
GET /api/v1/health
```

**响应**

```json
{
  "status": "ok"
}
```

---

## 2. 主动推送

通过 SSE 长连接接收新消息事件，端口与 HTTP API 共用。

**请求**

```http
GET /api/v1/push/messages
```

### 说明

- 需要先在设置页开启 `HTTP API 服务`
- 同时需要开启 `主动推送`
- 响应类型为 `text/event-stream`
- 新消息事件名固定为 `message.new`
- 建议接收端按 `messageKey` 去重

### 事件字段

- `event`
- `sessionId`
- `messageKey`
- `avatarUrl`
- `sourceName`
- `groupName`（仅群聊）
- `content`

### 示例

```bash
curl -N "http://127.0.0.1:5031/api/v1/push/messages?access_token=YOUR_TOKEN
```

示例事件：

```text
event: message.new
data: {"event":"message.new","sessionId":"xxx@chatroom","messageKey":"server:123456:1760000123:1760000123000:321:wxid_member:1","avatarUrl":"https://example.com/group.jpg","sourceName":"李四","groupName":"项目群","content":"[图片]"}
```

---

## 3. 获取消息

> 当使用 POST 时，请将参数放在 JSON Body 中（Content-Type: application/json）

读取指定会话的消息，支持原始 JSON 和 ChatLab 格式。

**请求**

```http
GET /api/v1/messages
```

### 参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `talker` | string | 是 | 会话 ID。私聊通常是对方 `wxid`，群聊是 `xxx@chatroom` |
| `limit` | number | 否 | 返回条数，默认 `100`，范围 `1~10000` |
| `offset` | number | 否 | 分页偏移，默认 `0` |
| `start` | string | 否 | 开始时间，支持 `YYYYMMDD` 或时间戳 |
| `end` | string | 否 | 结束时间，支持 `YYYYMMDD` 或时间戳 |
| `keyword` | string | 否 | 基于消息显示文本过滤 |
| `chatlab` | string | 否 | `1/true` 时输出 ChatLab 格式 |
| `format` | string | 否 | `json` 或 `chatlab` |
| `media` | string | 否 | `1/true` 时导出媒体并返回媒体地址，兼容别名 `meiti` |
| `image` | string | 否 | 在 `media=1` 时控制图片导出，兼容别名 `tupian` |
| `voice` | string | 否 | 在 `media=1` 时控制语音导出，兼容别名 `vioce` |
| `video` | string | 否 | 在 `media=1` 时控制视频导出 |
| `emoji` | string | 否 | 在 `media=1` 时控制表情导出 |

### 示例

```bash
curl "http://127.0.0.1:5031/api/v1/messages?talker=wxid_xxx&limit=20"
curl "http://127.0.0.1:5031/api/v1/messages?talker=xxx@chatroom&chatlab=1"
curl "http://127.0.0.1:5031/api/v1/messages?talker=wxid_xxx&start=20260101&end=20260131"
curl "http://127.0.0.1:5031/api/v1/messages?talker=xxx@chatroom&media=1&image=1&voice=0&video=0&emoji=0"
```

### JSON 响应字段

顶层字段：

- `success`
- `talker`
- `count`
- `hasMore`
- `media.enabled`
- `media.exportPath`
- `media.count`
- `messages`

单条消息字段：

- `localId`
- `serverId`
- `localType`
- `createTime`
- `isSend`
- `senderUsername`
- `content`
- `rawContent`
- `parsedContent`
- `mediaType`
- `mediaFileName`
- `mediaUrl`
- `mediaLocalPath`

**示例响应**

```json
{
  "success": true,
  "talker": "xxx@chatroom",
  "count": 2,
  "hasMore": true,
  "media": {
    "enabled": true,
    "exportPath": "C:\\Users\\Alice\\Documents\\WeFlow\\api-media",
    "count": 1
  },
  "messages": [
    {
      "localId": 123,
      "serverId": "456",
      "localType": 1,
      "createTime": 1738713600,
      "isSend": 0,
      "senderUsername": "wxid_member",
      "content": "你好",
      "rawContent": "你好",
      "parsedContent": "你好"
    },
    {
      "localId": 124,
      "localType": 3,
      "createTime": 1738713660,
      "isSend": 0,
      "senderUsername": "wxid_member",
      "content": "[图片]",
      "mediaType": "image",
      "mediaFileName": "abc123.jpg",
      "mediaUrl": "http://127.0.0.1:5031/api/v1/media/xxx@chatroom/images/abc123.jpg",
      "mediaLocalPath": "C:\\Users\\Alice\\Documents\\WeFlow\\api-media\\xxx@chatroom\\images\\abc123.jpg"
    }
  ]
}
```

### ChatLab 响应

当 `chatlab=1` 或 `format=chatlab` 时，返回 ChatLab 结构：

- `chatlab.version`
- `chatlab.exportedAt`
- `chatlab.generator`
- `meta.name`
- `meta.platform`
- `meta.type`
- `meta.groupId`
- `meta.groupAvatar`
- `meta.ownerId`
- `members[].platformId`
- `members[].accountName`
- `members[].groupNickname`
- `members[].avatar`
- `messages[].sender`
- `messages[].accountName`
- `messages[].groupNickname`
- `messages[].timestamp`
- `messages[].type`
- `messages[].content`
- `messages[].platformMessageId`
- `messages[].mediaPath`

群聊里 `groupNickname` 会优先来自群成员群昵称；若源数据缺失，则回退为空或展示名。

---

## 4. 获取会话列表

> 当使用 POST 时，请将参数放在 JSON Body 中（Content-Type: application/json）

**请求**

```http
GET /api/v1/sessions
```

### 参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | string | 否 | 匹配 `username` 或 `displayName` |
| `limit` | number | 否 | 默认 `100` |

### 响应字段

- `success`
- `count`
- `sessions[].username`
- `sessions[].displayName`
- `sessions[].type`
- `sessions[].lastTimestamp`
- `sessions[].unreadCount`

**示例响应**

```json
{
  "success": true,
  "count": 1,
  "sessions": [
    {
      "username": "xxx@chatroom",
      "displayName": "项目群",
      "type": 2,
      "lastTimestamp": 1738713600,
      "unreadCount": 0
    }
  ]
}
```

---

## 5. 获取联系人列表

> 当使用 POST 时，请将参数放在 JSON Body 中（Content-Type: application/json）

**请求**

```http
GET /api/v1/contacts
```

### 参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | string | 否 | 匹配 `username`、`nickname`、`remark`、`displayName` |
| `limit` | number | 否 | 默认 `100` |

### 响应字段

- `success`
- `count`
- `contacts[].username`
- `contacts[].displayName`
- `contacts[].remark`
- `contacts[].nickname`
- `contacts[].alias`
- `contacts[].avatarUrl`
- `contacts[].type`

**示例响应**

```json
{
  "success": true,
  "count": 1,
  "contacts": [
    {
      "username": "wxid_xxx",
      "displayName": "张三",
      "remark": "客户张三",
      "nickname": "张三",
      "alias": "zhangsan",
      "avatarUrl": "https://example.com/avatar.jpg",
      "type": "friend"
    }
  ]
}
```

---

## 6. 获取群成员列表

> 当使用 POST 时，请将参数放在 JSON Body 中（Content-Type: application/json）

返回群成员的 `wxid`、群昵称、备注、微信号等信息。

**请求**

```http
GET /api/v1/group-members
```

### 参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `chatroomId` | string | 是 | 群 ID，兼容使用 `talker` 传入 |
| `includeMessageCounts` | string | 否 | `1/true` 时附带成员发言数 |
| `withCounts` | string | 否 | `includeMessageCounts` 的别名 |
| `forceRefresh` | string | 否 | `1/true` 时跳过内存缓存强制刷新 |

### 响应字段

- `success`
- `chatroomId`
- `count`
- `fromCache`
- `updatedAt`
- `members[].wxid`
- `members[].displayName`
- `members[].nickname`
- `members[].remark`
- `members[].alias`
- `members[].groupNickname`
- `members[].avatarUrl`
- `members[].isOwner`
- `members[].isFriend`
- `members[].messageCount`

**示例请求**

```bash
curl "http://127.0.0.1:5031/api/v1/group-members?chatroomId=xxx@chatroom"
curl "http://127.0.0.1:5031/api/v1/group-members?chatroomId=xxx@chatroom&includeMessageCounts=1&forceRefresh=1"
```

**示例响应**

```json
{
  "success": true,
  "chatroomId": "xxx@chatroom",
  "count": 2,
  "fromCache": false,
  "updatedAt": 1760000000000,
  "members": [
    {
      "wxid": "wxid_member_a",
      "displayName": "客户A",
      "nickname": "阿甲",
      "remark": "客户A",
      "alias": "kehua",
      "groupNickname": "甲方",
      "avatarUrl": "https://example.com/a.jpg",
      "isOwner": true,
      "isFriend": true,
      "messageCount": 128
    },
    {
      "wxid": "wxid_member_b",
      "displayName": "李四",
      "nickname": "李四",
      "remark": "",
      "alias": "",
      "groupNickname": "",
      "avatarUrl": "",
      "isOwner": false,
      "isFriend": false,
      "messageCount": 0
    }
  ]
}
```

说明：

- `displayName` 是当前应用内的主展示名。
- `groupNickname` 是成员在该群里的群昵称。
- `remark` 是你对该联系人的备注。
- `alias` 是微信号。
- 当微信源数据里没有群昵称时，`groupNickname` 会为空。

---

## 7. 访问导出媒体

> 当使用 POST 时，请将参数放在 JSON Body 中（Content-Type: application/json）

通过消息接口启用 `media=1` 后，接口会先把图片、语音、视频、表情导出到本地缓存目录，再返回可访问的 HTTP 地址。

**请求**

```http
GET /api/v1/media/{relativePath}
```

### 示例

```bash
curl "http://127.0.0.1:5031/api/v1/media/xxx@chatroom/images/abc123.jpg"
curl "http://127.0.0.1:5031/api/v1/media/xxx@chatroom/voices/voice_100.wav"
curl "http://127.0.0.1:5031/api/v1/media/xxx@chatroom/videos/video_200.mp4"
curl "http://127.0.0.1:5031/api/v1/media/xxx@chatroom/emojis/emoji_300.gif"
```

### 支持的 Content-Type

| 扩展名 | Content-Type |
| --- | --- |
| `.png` | `image/png` |
| `.jpg` / `.jpeg` | `image/jpeg` |
| `.gif` | `image/gif` |
| `.webp` | `image/webp` |
| `.wav` | `audio/wav` |
| `.mp3` | `audio/mpeg` |
| `.mp4` | `video/mp4` |

常见错误响应：

```json
{
  "error": "Media not found"
}
```

---

## 8. 使用示例

### PowerShell

```powershell
$headers = @{ "Authorization" = "Bearer YOUR_TOKEN" }
$body = @{ talker = "wxid_xxx"; limit = 10 } | ConvertTo-Json

Invoke-RestMethod -Uri "http://127.0.0.1:5031/api/v1/messages" -Method POST -Headers $headers -Body $body -ContentType "application/json"
```

### cURL

```bash
# GET 带 Token Header
curl -H "Authorization: Bearer YOUR_TOKEN" "http://127.0.0.1:5031/api/v1/messages?talker=wxid_xxx"

# POST 带 JSON Body
curl -X POST http://127.0.0.1:5031/api/v1/messages \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"talker": "xxx@chatroom", "chatlab": true}'
```

### Python

```python
import requests

BASE_URL = "http://127.0.0.1:5031"
headers = {"Authorization": "Bearer YOUR_TOKEN", "Content-Type": "application/json"}

# POST 方式获取消息
messages = requests.post(
    f"{BASE_URL}/api/v1/messages", 
    json={"talker": "xxx@chatroom", "limit": 50}, 
    headers=headers
).json()

# GET 方式获取群成员
members = requests.get(
    f"{BASE_URL}/api/v1/group-members",
    params={"chatroomId": "xxx@chatroom", "includeMessageCounts": 1},
    headers=headers
).json()
```

---

## 9. 注意事项

1. API 仅监听本机 `127.0.0.1`，不对外网开放。
2. 使用前需要先在 WeFlow 中完成数据库连接。
3. `start` 和 `end` 支持 `YYYYMMDD` 与时间戳；纯 `YYYYMMDD` 的 `end` 会扩展到当天 `23:59:59`。
4. 群成员的 `groupNickname` 依赖微信源数据；源数据缺失时不会自动补出。
5. 媒体访问链接只有在对应消息已经通过 `media=1` 导出后才可访问。
