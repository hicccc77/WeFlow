# WeFlow HTTP API 接口文档

WeFlow 提供 HTTP API 服务，支持通过 HTTP 接口查询消息数据，支持 [ChatLab](https://github.com/nichuanfang/chatlab-format) 标准化格式输出。

## 启用 API 服务

在设置页面 → API 服务 → 点击「启动服务」按钮。

默认端口：`5031`

## 基础地址

```
http://127.0.0.1:5031
```

---

## 接口列表

### 1. 健康检查

检查 API 服务是否正常运行。

**请求**
```
GET /health
```

**响应**
```json
{
  "status": "ok"
}
```

---

### 2. 获取消息列表

获取指定会话的消息，支持 ChatLab 格式输出。

**请求**
```
GET /api/v1/messages
```

**参数**

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `talker` | string | ✅ | 会话 ID（wxid 或群 ID） |
| `limit` | number | ❌ | 返回数量限制，默认 100 |
| `offset` | number | ❌ | 偏移量，用于分页，默认 0 |
| `start` | string | ❌ | 开始时间，格式 YYYYMMDD |
| `end` | string | ❌ | 结束时间，格式 YYYYMMDD |
| `chatlab` | string | ❌ | 设为 `1` 则输出 ChatLab 格式 |
| `format` | string | ❌ | 输出格式：`json`（默认）或 `chatlab` |

**示例请求**

```bash
# 获取消息（原始格式）
GET http://127.0.0.1:5031/api/v1/messages?talker=wxid_xxx&limit=50

# 获取消息（ChatLab 格式）
GET http://127.0.0.1:5031/api/v1/messages?talker=wxid_xxx&chatlab=1

# 带时间范围查询
GET http://127.0.0.1:5031/api/v1/messages?talker=wxid_xxx&start=20260101&end=20260205&limit=100
```

**响应（原始格式）**
```json
{
  "success": true,
  "talker": "wxid_xxx",
  "count": 50,
  "hasMore": true,
  "messages": [
    {
      "localId": 123,
      "talker": "wxid_xxx",
      "type": 1,
      "content": "消息内容",
      "createTime": 1738713600000,
      "isSelf": false,
      "sender": "wxid_sender"
    }
  ]
}
```

**响应（ChatLab 格式）**
```json
{
  "chatlab": {
    "version": "0.0.2",
    "exportedAt": 1738713600000,
    "generator": "WeFlow",
    "description": "Exported from WeFlow"
  },
  "meta": {
    "name": "会话名称",
    "platform": "wechat",
    "type": "private",
    "ownerId": "wxid_me"
  },
  "members": [
    {
      "platformId": "wxid_xxx",
      "accountName": "用户名",
      "groupNickname": "群昵称"
    }
  ],
  "messages": [
    {
      "sender": "wxid_xxx",
      "accountName": "用户名",
      "timestamp": 1738713600000,
      "type": 0,
      "content": "消息内容"
    }
  ]
}
```

---

### 3. 获取会话列表

获取所有会话列表。

**请求**
```
GET /api/v1/sessions
```

**参数**

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `keyword` | string | ❌ | 搜索关键词，匹配会话名或 ID |
| `limit` | number | ❌ | 返回数量限制，默认 100 |

**示例请求**
```bash
GET http://127.0.0.1:5031/api/v1/sessions

GET http://127.0.0.1:5031/api/v1/sessions?keyword=工作群&limit=20
```

**响应**
```json
{
  "success": true,
  "count": 50,
  "total": 100,
  "sessions": [
    {
      "username": "wxid_xxx",
      "displayName": "用户名",
      "lastMessage": "最后一条消息",
      "lastTime": 1738713600000,
      "unreadCount": 0
    }
  ]
}
```

---

### 4. 获取联系人列表

获取所有联系人信息。

**请求**
```
GET /api/v1/contacts
```

**参数**

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `keyword` | string | ❌ | 搜索关键词 |
| `limit` | number | ❌ | 返回数量限制，默认 100 |

**示例请求**
```bash
GET http://127.0.0.1:5031/api/v1/contacts

GET http://127.0.0.1:5031/api/v1/contacts?keyword=张三
```

**响应**
```json
{
  "success": true,
  "count": 50,
  "contacts": [
    {
      "userName": "wxid_xxx",
      "alias": "微信号",
      "nickName": "昵称",
      "remark": "备注名"
    }
  ]
}
```

---

## ChatLab 格式说明

ChatLab 是一种标准化的聊天记录交换格式，版本 0.0.2。

### 消息类型映射

| ChatLab Type | 值 | 说明 |
|--------------|-----|------|
| TEXT | 0 | 文本消息 |
| IMAGE | 1 | 图片 |
| VOICE | 2 | 语音 |
| VIDEO | 3 | 视频 |
| FILE | 4 | 文件 |
| EMOJI | 5 | 表情 |
| LINK | 7 | 链接 |
| LOCATION | 8 | 位置 |
| RED_PACKET | 20 | 红包 |
| TRANSFER | 21 | 转账 |
| CALL | 23 | 通话 |
| SYSTEM | 80 | 系统消息 |
| RECALL | 81 | 撤回消息 |
| OTHER | 99 | 其他 |

---

## 使用示例

### PowerShell

```powershell
# 健康检查
Invoke-RestMethod http://127.0.0.1:5031/health

# 获取会话列表
Invoke-RestMethod http://127.0.0.1:5031/api/v1/sessions

# 获取消息
Invoke-RestMethod "http://127.0.0.1:5031/api/v1/messages?talker=wxid_xxx&limit=10"

# 获取 ChatLab 格式
Invoke-RestMethod "http://127.0.0.1:5031/api/v1/messages?talker=wxid_xxx&chatlab=1" | ConvertTo-Json -Depth 10
```

### cURL

```bash
# 健康检查
curl http://127.0.0.1:5031/health

# 获取会话列表
curl http://127.0.0.1:5031/api/v1/sessions

# 获取消息（ChatLab 格式）
curl "http://127.0.0.1:5031/api/v1/messages?talker=wxid_xxx&chatlab=1"
```

### Python

```python
import requests

BASE_URL = "http://127.0.0.1:5031"

# 获取会话列表
sessions = requests.get(f"{BASE_URL}/api/v1/sessions").json()
print(sessions)

# 获取消息
messages = requests.get(f"{BASE_URL}/api/v1/messages", params={
    "talker": "wxid_xxx",
    "limit": 100,
    "chatlab": 1
}).json()
print(messages)
```

### JavaScript / Node.js

```javascript
const BASE_URL = "http://127.0.0.1:5031";

// 获取会话列表
const sessions = await fetch(`${BASE_URL}/api/v1/sessions`).then(r => r.json());
console.log(sessions);

// 获取消息（ChatLab 格式）
const messages = await fetch(`${BASE_URL}/api/v1/messages?talker=wxid_xxx&chatlab=1`)
  .then(r => r.json());
console.log(messages);
```

---

## 注意事项

1. API 仅监听本地地址 `127.0.0.1`，不对外网开放
2. 需要先连接数据库才能查询数据
3. 时间参数格式为 `YYYYMMDD`（如 20260205）
4. 支持 CORS，可从浏览器前端直接调用
