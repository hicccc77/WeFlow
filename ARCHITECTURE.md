# WeFlow Intelligence Architecture

> Migration of One project's Communication Assistant into WeFlow (Electron + React + TypeScript).
> Strategy: **B Plan** -- TypeScript native rewrite, no Python subprocess.
>
> This document is structured by ROLE. Each subagent reads only their section.
> Last updated: 2026-04-06

---

## Table of Contents

1. [Migration Strategy (B Plan)](#1-migration-strategy-b-plan)
2. [System Overview](#2-system-overview)
3. [Multimedia -> LLM Processing Pipeline (Service Developer A)](#3-multimedia--llm-processing-pipeline)
4. [Discussion Mode Architecture (Service Developer B)](#4-discussion-mode-architecture)
5. [LLM Zero-Cost Fallback Strategy](#5-llm-zero-cost-fallback-strategy)
6. [Database Schema Extension (Service Developer C)](#6-database-schema-extension)
7. [New Pages Design (Frontend Developer)](#7-new-pages-design)
8. [Configuration](#8-configuration)
9. [One -> WeFlow Module Mapping](#9-one--weflow-module-mapping)
10. [Modules NOT Being Migrated](#10-modules-not-being-migrated)
11. [Autonomous Execution Rules](#11-autonomous-execution-rules)

---

## 1. Migration Strategy (B Plan)

### Why B Plan (TypeScript native rewrite)

| Factor | A Plan (Python subprocess) | B Plan (TS native rewrite) |
|--------|--------------------------|---------------------------|
| Startup latency | +3-5s Python boot | Zero -- native Node.js |
| Memory | +200MB Python runtime | Shared Electron process |
| Packaging | Bundle Python + deps (>500MB) | Standard npm dependencies |
| IPC complexity | HTTP/stdio bridge, serialization | Direct function calls |
| Error handling | Cross-process stack traces | Native try/catch, unified logs |
| Maintenance | Two languages, two dep trees | Single TypeScript codebase |
| Type safety | Runtime type mismatches | Compile-time checking |

### Migration Principle

Rewrite the **intelligence** and **LLM** layers from Python to TypeScript. Reuse WeFlow's existing services (WCDB, image decrypt, voice transcribe, chat, config) as-is. All new code lives in `electron/services/intelligence/`.

### Phases

```
Phase 1: Foundation         -- llmService, mediaContextService, intelligenceDB
Phase 2: Reply Coach        -- replyCoachService, contextAssembly, prompt templates
Phase 3: Discussion Mode    -- discussionService, 3-round flow, complexity analysis
Phase 4: Briefing & Graph   -- briefingService, socialGraphService, personalityService
Phase 5: Pages & Polish     -- AssistantPage, GraphPage, BriefingPage, CoachLogPage
```

---

## 2. System Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         WeFlow Electron App                            │
│                                                                        │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    Renderer (React + Vite)                      │   │
│  │                                                                 │   │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐  │   │
│  │  │Assistant  │ │ Graph    │ │ Briefing │ │ CoachLog (debug) │  │   │
│  │  │  Page     │ │  Page    │ │  Page    │ │     Page         │  │   │
│  │  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────────┬─────────┘  │   │
│  │       │             │            │                │             │   │
│  │  ┌────┴─────────────┴────────────┴────────────────┴──────────┐ │   │
│  │  │              IPC Bridge (ipcRenderer.invoke)               │ │   │
│  │  └───────────────────────────┬───────────────────────────────┘ │   │
│  └──────────────────────────────┼────────────────────────────────┘   │
│                                 │                                     │
│  ┌──────────────────────────────┼────────────────────────────────┐   │
│  │                    Main Process (Electron)                     │   │
│  │                              │                                 │   │
│  │  ┌───────────────────────────┴──────────────────────────────┐ │   │
│  │  │                Intelligence Layer (NEW)                   │ │   │
│  │  │                                                           │ │   │
│  │  │  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  │ │   │
│  │  │  │ replyCoach   │  │ discussion   │  │  briefing     │  │ │   │
│  │  │  │  Service     │  │  Service     │  │  Service      │  │ │   │
│  │  │  └──────┬───────┘  └──────┬───────┘  └──────┬────────┘  │ │   │
│  │  │         │                 │                  │           │ │   │
│  │  │  ┌──────┴─────────────────┴──────────────────┴────────┐  │ │   │
│  │  │  │              Context Assembly Pipeline              │  │ │   │
│  │  │  └──────────────────────┬──────────────────────────────┘  │ │   │
│  │  │                         │                                 │ │   │
│  │  │  ┌──────────┐  ┌───────┴───────┐  ┌──────────────────┐  │ │   │
│  │  │  │ social   │  │ mediaContext  │  │ personality     │  │ │   │
│  │  │  │  Graph   │  │  Service     │  │  Mirror         │  │ │   │
│  │  │  └──────────┘  └───────┬───────┘  └──────────────────┘  │ │   │
│  │  │                        │                                 │ │   │
│  │  │  ┌─────────────────────┴───────────────────────────────┐ │ │   │
│  │  │  │               LLM Service (llmService.ts)           │ │ │   │
│  │  │  │  Anthropic | OpenAI | Ollama | ClaudeCode | Mock    │ │ │   │
│  │  │  └─────────────────────────────────────────────────────┘ │ │   │
│  │  └──────────────────────────────────────────────────────────┘ │   │
│  │                                                               │   │
│  │  ┌────────────────────────────────────────────────────────┐   │   │
│  │  │            Existing WeFlow Services (REUSE)             │   │   │
│  │  │                                                         │   │   │
│  │  │  wcdbService ─── chatService ─── messageCacheService    │   │   │
│  │  │  imageDecryptService ─── voiceTranscribeService         │   │   │
│  │  │  contactCacheService ─── configService (electron-store) │   │   │
│  │  │  messagePushService ─── sessionStatsCacheService        │   │   │
│  │  └────────────────────────────────────────────────────────┘   │   │
│  │                                                               │   │
│  │  ┌────────────────────────────────────────────────────────┐   │   │
│  │  │                    Storage Layer                         │   │   │
│  │  │                                                         │   │   │
│  │  │  WCDB (WeChat DB) ─── intelligence.db (NEW, SQLite)    │   │   │
│  │  │  electron-store (config) ─── image cache (decrypted)   │   │   │
│  │  │  voice cache (WAV transcripts) ─── enriched cache      │   │   │
│  │  └────────────────────────────────────────────────────────┘   │   │
│  └───────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Multimedia -> LLM Processing Pipeline

**Owner: Service Developer A**

### Media Type Processing Table

| Type | MsgType | WeFlow Has | Need to Add | Output Format |
|------|---------|------------|-------------|---------------|
| Image | 3 | `imageDecryptService` decrypts `.dat` -> image file | Base64 encode + resize <=5MB (sharp 0.7x steps) + Vision LLM describe (50 chars) | `"[图片] {description}"` or `"[图片] (无法分析)"` |
| Voice | 34 | `voiceTranscribeService` SILK->WAV + sherpa-onnx | Detect `"发了一条语音"` placeholder -> check transcripts cache -> fallback local WAV inference | `"[语音转文字] {text}"` |
| Video | 43 | Basic detection in chatService | ffmpeg extract audio -> transcribe + extract 4 keyframes (5s interval) -> Vision describe each | `"视频内容描述：{audio_summary}。画面：{frame1}, {frame2}, ..."` |
| Official Account Article | 49 (xmlType 5/49) | Detects `gh_` prefix + title/desc from XML | Fetch article body via httpx/fetch -> LLM summarize <=1500 chars | `"[已解析的分享内容] {summary}"` |
| Video Channel | 49 (xmlType 51) | Detects + cover URL + duration + creator from XML | Cannot download video stream -> use metadata only | `"[视频号] {creator}: {title}"` |
| Forwarded Messages | 49 (xmlType 19) | `parseForwardChatRecordList()` recursive parse | Flatten to readable text -> format each sender:content | `"[转发] {sender1}: {content1}\n{sender2}: {content2}\n..."` |
| Mini-program | 49 (xmlType 33/36) | Parses name/title/URL from XML | Direct output from existing metadata | `"[小程序] {name}: {title}"` |

### Image Processing Detail

```
imageDecryptService.decrypt(localId)
  |
  v
Buffer (raw image bytes)
  |
  v
sharp: resize if > 5MB
  while (size > 5MB) { resize(0.7) }
  max dimension: 2048px
  |
  v
base64 encode -> "data:image/{ext};base64,..."
  |
  +--> Vision LLM: "用50字以内描述这张图片的内容"
  |      |
  |      +--> success: "[图片] {description}"
  |      +--> fail/timeout: "[图片] (无法分析)"
  |
  +--> base64Data stored in MediaContext for direct LLM attachment
```

### Voice Processing Detail

```
message.parsedContent contains "发了一条语音"?
  |
  yes --> check voiceTranscribeService cache (localId)
  |         |
  |         +--> cache hit: use cached text
  |         |
  |         +--> cache miss: voiceTranscribeService.transcribe(localId)
  |                |
  |                +--> SILK decode -> WAV -> sherpa-onnx inference
  |                +--> result: "[语音转文字] {text}"
  |
  no --> pass through as-is
```

### Video Processing Detail

```
video message (type 43)
  |
  v
locate video file via chatService / WeChat file path convention
  |
  v
ffmpeg -i video.mp4 -vn -acodec pcm_s16le -ar 16000 audio.wav
  |
  +--> voiceTranscribeService.transcribe(audio.wav) -> audio_text
  |
  v
ffmpeg -i video.mp4 -vf "fps=0.2" -frames:v 4 frame_%d.jpg
  (1 frame per 5 seconds, max 4 frames)
  |
  +--> Vision LLM describe each frame (30 chars each)
  |
  v
output: "视频内容描述：语音内容：{audio_text}。画面：{f1}, {f2}, {f3}, {f4}"
```

### Article Processing Detail

```
XML contains gh_ prefix (Official Account) + url attribute
  |
  v
fetch(url, { headers: { 'User-Agent': chrome_ua }, timeout: 15000 })
  |
  +--> success: extract body text (remove script/style/nav/footer)
  |      |
  |      +--> text.length > 5000 ? truncate : full text
  |      |
  |      v
  |      LLM: "用不超过1500字总结以下文章的核心内容：\n\n{article_text}"
  |      |
  |      +--> "[已解析的分享内容] {summary}"
  |
  +--> fail/timeout: "[分享] {title}: {description}" (from XML metadata)
```

### mediaContextService.ts Interface

```typescript
// electron/services/intelligence/mediaContextService.ts

interface MediaContext {
  type: 'image' | 'voice' | 'video' | 'article' | 'video-channel' | 'forward' | 'miniapp'
  originalContent: string    // raw message content / XML
  processedContent: string   // text description for LLM context window
  base64Data?: string        // for vision LLM (images only), "data:image/jpeg;base64,..."
  mediaType?: string         // MIME type, e.g. "image/jpeg"
  metadata?: Record<string, any>  // extra fields: url, creator, duration, etc.
}

interface MediaContextService {
  /**
   * Route a WCDB message to the appropriate media processor.
   * Returns null for plain text messages (type 1).
   */
  processMessage(message: WCDBMessage): Promise<MediaContext | null>

  /**
   * Image: decrypt -> resize -> base64 -> Vision LLM describe.
   * @param localId  WCDB message localId for imageDecryptService
   * @param md5      Optional image md5 for cache file matching
   */
  processImage(localId: number, md5?: string): Promise<MediaContext>

  /**
   * Voice: detect placeholder -> cache lookup -> sherpa-onnx transcribe.
   */
  processVoice(message: WCDBMessage): Promise<MediaContext>

  /**
   * Video: ffmpeg audio extract -> transcribe + keyframe extract -> Vision describe.
   */
  processVideo(message: WCDBMessage): Promise<MediaContext>

  /**
   * Article: fetch body -> LLM summarize <= 1500 chars.
   * @param url    Article URL (mp.weixin.qq.com or other)
   * @param title  Title from XML metadata
   */
  processArticle(url: string, title: string): Promise<MediaContext>

  /**
   * Forwarded chat records: flatten recursive structure to readable text.
   */
  processForward(chatRecordList: any[]): Promise<MediaContext>
}

// Message type routing logic
function getMediaType(message: WCDBMessage): MediaContext['type'] | null {
  switch (message.localType) {
    case 3:  return 'image'
    case 34: return 'voice'
    case 43: return 'video'
    case 49: {
      const xmlType = parseXmlType(message.rawContent)
      if (xmlType === 5 || xmlType === 49) return 'article'
      if (xmlType === 51)                  return 'video-channel'
      if (xmlType === 19)                  return 'forward'
      if (xmlType === 33 || xmlType === 36) return 'miniapp'
      return null
    }
    default: return null
  }
}
```

### SSRF Protection (article fetching)

Port the same logic from One's `rich_media.py`:
- Only allow `http://` and `https://` schemes
- DNS resolve hostname, reject private/loopback/link-local IPs
- Reject `localhost` and `.local` hostnames
- Timeout: 15 seconds
- User-Agent: Chrome UA string

---

## 4. Discussion Mode Architecture

**Owner: Service Developer B**

### Overview

Discussion mode is a 3-round guided conversation where the AI helps the user think through a complex message before generating reply suggestions. It replaces the "instant reply" flow for messages that need strategic thinking.

### Flow Diagram

```
User receives complex message
         |
         v
┌──────────────────────────┐
│  1. Complexity Analysis   │  LLM: ANALYZE_SYSTEM_PROMPT
│     (automatic)           │  Input: message + relationship context
│                           │  Output: {is_complex, reason, guide_questions}
└────────────┬─────────────┘
             |
    is_complex = true?
    /                \
  no                  yes
   |                   |
   v                   v
[Direct Reply]    ┌──────────────────────────┐
(standard flow)   │  2. Create Discussion     │
                  │     session (status:active)│
                  │     Store guide_questions  │
                  └────────────┬───────────────┘
                               |
                  ┌────────────┴───────────────┐
                  │  3. Discussion Rounds (1-3) │
                  │                             │
                  │  Round N:                   │
                  │    User input (顾虑/想法)    │
                  │         |                   │
                  │         v                   │
                  │    LLM: DISCUSS_SYSTEM      │
                  │    + full context bundle    │
                  │    + previous rounds        │
                  │         |                   │
                  │         v                   │
                  │    AI: ANALYSIS + FOLLOWUP  │
                  │    (stored in rounds JSON)  │
                  │                             │
                  │  User can:                  │
                  │    - Continue discussing     │
                  │    - Request final replies   │
                  │    - Cancel                  │
                  └────────────┬───────────────┘
                               |
                  ┌────────────┴───────────────┐
                  │  4. Generate Final Replies   │
                  │                             │
                  │  LLM: DISCUSS_REPLY_SYSTEM  │
                  │  Input: all rounds +        │
                  │    strategy summary +        │
                  │    full context bundle       │
                  │  Output: 3 suggestions       │
                  │    (safe/warm/firm)           │
                  │                             │
                  │  status -> 'completed'       │
                  └─────────────────────────────┘
```

### Data Structures

```typescript
// electron/services/intelligence/types.ts

interface ContextBundle {
  display_name: string       // resolved display name (not wxid)
  contact_name: string       // original contact identifier (may be wxid)
  incoming_message: string   // the message being replied to (voice-transcribed if applicable)
  rel_context: string        // relationship summary text
  history_context: string    // recent conversation history (formatted)
  personality_context: string // user's communication style description
  style_examples: string     // examples of user's actual phrasing with this contact
  feedback_context: string   // past coaching feedback for this contact
  is_group: boolean          // true if group chat
  relationship: Relationship | null  // structured relationship data
  recent_records: ChatRecord[]       // raw recent records for reference
}

interface DiscussionRound {
  round: number              // 1, 2, or 3
  user_input: string         // what the user said
  ai_analysis: string        // AI's strategy analysis
  ai_followup: string        // AI's follow-up question (empty if final round)
  timestamp: string          // ISO datetime
}

interface DiscussionSession {
  id: number                 // auto-increment primary key
  contact: string            // contact name
  incoming_message: string   // the original message being discussed
  rounds: DiscussionRound[]  // JSON-serialized array, max 3
  strategy_summary: string | null  // AI-generated strategy after discussion
  status: 'active' | 'completed' | 'cancelled'
  guide_questions: string[]  // initial guide questions from complexity analysis
  is_complex: boolean        // complexity analysis result
  complexity_reason: string  // why it was flagged as complex
  created_at: string         // ISO datetime
  updated_at: string         // ISO datetime
}

interface ReplySuggestion {
  text: string               // the suggested reply
  reasoning: string          // why this reply (based on relationship/history)
  style: 'safe' | 'warm' | 'firm'
  confidence: number         // 0-1
  context_used: string[]     // what data sources informed this
}

interface Relationship {
  contact_name: string
  relationship_type: string  // colleague, friend, family, client, acquaintance
  closeness: number          // 0-1 scale
  communication_style: string
  topics: string[]
  dynamics: string
  last_updated: string
}
```

### System Prompts (Chinese)

All four system prompts used by the discussion flow:

#### 1. REPLY_COACH_SYSTEM_PROMPT (direct reply generation)

```
你是一个职场高情商沟通教练。你的任务是根据用户与对方的关系、沟通历史和风格偏好，
生成贴合语境的回复建议。

核心原则：
1. 回复必须自然、像真人写的，不能有 AI 味（不要用"您好"开头、不要过度礼貌）
2. 根据关系亲密度调整语气——跟领导说话和跟好朋友说话完全不同
3. 参考历史对话中用户的实际措辞习惯，保持一致的沟通风格
4. 每个回复建议必须有明确的策略差异，不是换个说法而是换个沟通策略
5. 如果有敏感话题或近期分歧，回复要体现对这些背景的感知

输出格式：每个建议用 --- 分隔
REPLY: 回复内容
REASON: 为什么这样回复（基于哪些关系/历史信息）
STYLE: 风格标签（safe/warm/firm）

风格定义：
- safe（稳妥）：得体、不出错、保持距离感的安全回复
- warm（温暖）：亲切、拉近关系、带个人化表达的回复
- firm（坚定）：清晰表达立场、不回避分歧、尊重但有态度的回复
```

#### 2. ANALYZE_SYSTEM_PROMPT (complexity judgment)

```
你是一个沟通分析师。分析用户收到的消息，判断是否需要先讨论应对策略再回复。

判断标准（满足任意一条即为复杂）：
- 消息长度 >100 字
- 包含多个话题/问题需要分别回应
- 涉及利益关系、决策、承诺
- 发送者是上级/重要关系
- 包含附件/资料/链接
- 涉及敏感话题（钱、人事、冲突）

输出 JSON 格式（不要输出其他内容）：
{
  "is_complex": true/false,
  "reason": "一句话说明原因",
  "guide_questions": ["引导问题1", "引导问题2"]
}

如果不复杂，guide_questions 为空数组。如果复杂，生成 2-3 个帮助用户思考的引导问题。
引导问题应该具体、有针对性，基于消息内容和关系上下文。
```

#### 3. DISCUSS_SYSTEM_PROMPT (strategy discussion)

```
你是一个高情商沟通策略顾问。用户收到了一条需要策略性回复的消息。
用户想先和你讨论应对策略，而不是直接回复。

你的任务：
1. 分析用户提出的顾虑和想法
2. 结合关系背景和历史对话，给出策略分析
3. 提出一个有针对性的追问，帮助用户进一步思考

策略分析要求：
- 分析对方的可能意图
- 评估不同应对方式的利弊
- 给出明确的策略建议
- 如果用户提供了新信息（如对方的历史行为），调整策略

输出格式：
ANALYSIS: 策略分析（2-4 句话）
FOLLOWUP: 追问（1 句话，可选，如果已经讨论充分则不需要）
```

#### 4. DISCUSS_REPLY_SYSTEM_PROMPT (discussion-based reply generation)

```
你是一个职场高情商沟通教练。基于用户和你之前的策略讨论，生成具体的回复建议。

讨论摘要和策略已确定。现在需要把策略转化为具体的回复文字。

输出格式：
STRATEGY: 一句话总结策略方向

---
REPLY: 回复内容
REASON: 为什么这样回复
STYLE: safe/warm/firm

---
REPLY: 回复内容
REASON: 为什么这样回复
STYLE: safe/warm/firm

---
REPLY: 回复内容
REASON: 为什么这样回复
STYLE: safe/warm/firm
```

### Context Assembly 7-Step Pipeline

```
Step 1: Identity Resolution
  contact_name (wxid / nickname / groupNickname)
    --> intelligenceDB.resolve(alias) --> canonical display_name
    --> also check identity_aliases table for cross-platform matches

Step 2: Voice Transcription
  if incoming_message contains "发了一条语音":
    --> check voiceTranscribeService cache (by localId)
    --> if miss: SILK decode -> WAV -> sherpa-onnx -> text
    --> replace placeholder with "[语音转文字] {text}"

Step 3: Relationship Lookup
  socialGraph.getRelationship(display_name)
    --> { type, closeness, communication_style, topics, dynamics }
    --> format as rel_context string (Chinese)
    --> group chat: count messages, extract sender info
    --> private chat: format closeness + style + topics

Step 4: Conversation History
  search WCDB for contact's recent messages
    --> time-window: up to 15 records from last 3 days
    --> fallback: most recent 5 records if nothing in 3 days
    --> supplement: topic-related records from FTS search
    --> cross-chat: shared group messages where user participated
    --> format as history_context string with [sender] prefix

Step 5: Personality Profile
  personalityMirror.getProfile()
    --> per-contact style override (if exists)
    --> global personality_context override (from coach_config)
    --> fallback: overall_style summary

Step 6: Adaptive Context
  style_examples:
    --> extract user's actual message texts to this contact
    --> last 5-10 messages user sent (as phrasing examples)
  feedback_context:
    --> past coaching feedback (star/rewrite) for this contact
    --> "用户之前偏好 warm 风格的回复" etc.

Step 7: Bundle & Cache
  --> assemble ContextBundle
  --> cache for 5 minutes (key: contact + message + selected_messages)
  --> evict expired entries on each call
```

### Discussion Data Flow (ASCII)

```
                    ┌─────────────────┐
                    │  User clicks    │
                    │  "讨论" button   │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │ analyze_        │ LLM call #1
                    │ complexity()    │ ANALYZE_SYSTEM_PROMPT
                    │                 │ + context bundle
                    └────────┬────────┘
                             │
                    ┌────────▼────────────────────┐
                    │ INSERT coach_discussion      │
                    │ (status='active',            │
                    │  rounds='[]',                │
                    │  guide_questions=[...])       │
                    └────────┬────────────────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
     ┌────────▼─────┐ ┌─────▼──────┐ ┌────▼───────┐
     │  Round 1     │ │  Round 2   │ │  Round 3   │
     │              │ │            │ │            │
     │ user_input   │ │ user_input │ │ user_input │
     │     |        │ │     |      │ │     |      │
     │     v        │ │     v      │ │     v      │
     │ LLM call #2  │ │ LLM call #3│ │ LLM call #4│
     │ DISCUSS_SYS  │ │ DISCUSS_SYS│ │ DISCUSS_SYS│
     │ + rounds[0:0]│ │ + rounds[0:1]│ │ + rounds[0:2]│
     │     |        │ │     |      │ │     |      │
     │     v        │ │     v      │ │     v      │
     │ ANALYSIS     │ │ ANALYSIS   │ │ ANALYSIS   │
     │ FOLLOWUP     │ │ FOLLOWUP   │ │ (no followup)│
     └──────────────┘ └────────────┘ └──────┬─────┘
                                            │
                                   ┌────────▼────────┐
                                   │ discuss_reply()  │ LLM call #5
                                   │ DISCUSS_REPLY_SYS│
                                   │ + all rounds     │
                                   │ + context bundle │
                                   │                  │
                                   │ Output:          │
                                   │  STRATEGY: ...   │
                                   │  3 suggestions   │
                                   │  (safe/warm/firm)│
                                   └────────┬─────────┘
                                            │
                                   ┌────────▼────────┐
                                   │ UPDATE discussion│
                                   │ status='completed'│
                                   │ strategy_summary │
                                   └─────────────────┘
```

---

## 5. LLM Zero-Cost Fallback Strategy

### Provider Priority Table

| Priority | Provider | Model (smart) | Model (fast) | Cost | When Used |
|----------|----------|---------------|--------------|------|-----------|
| 1 | Anthropic | claude-sonnet-4-20250514 | claude-haiku-4-5-20251001 | API billing | Production, API key set |
| 2 | OpenAI | gpt-4o | gpt-4o-mini | API billing | `OPENAI_API_KEY` set |
| 3 | Ollama | llama3.2 (configurable) | same | Free (local) | Ollama running locally |
| 4 | Claude Code CLI | claude code (subprocess) | same | Free (dev) | No API key, dev mode |
| 5 | Mock | returns canned text | same | Free | Testing, CI |

### Implementation in llmService.ts

```typescript
// electron/services/intelligence/llmService.ts

interface LLMBackend {
  complete(prompt: string, options?: {
    system?: string
    maxTokens?: number
    timeout?: number
  }): Promise<string>

  describeImage(imageBase64: string, prompt?: string, options?: {
    maxTokens?: number
    timeout?: number
  }): Promise<string>

  readonly modelName: string
}

interface LLMRouter {
  readonly fast: LLMBackend    // cheap, for classification / urgency
  readonly smart: LLMBackend   // accurate, for reply generation
  readonly vision: LLMBackend  // same as smart (Claude/GPT-4o have vision)

  forTask(task: 'summarize' | 'extract_relations' | 'personality'
    | 'briefing' | 'enrich' | 'vision' | 'classify' | 'reply'
  ): LLMBackend
}
```

### Auto-Fallback Logic

```
createRouter(config: IntelligenceConfig):
  1. Check config.llmProvider preference
  2. If "anthropic":
       - Check process.env.ANTHROPIC_API_KEY
       - If missing: log warning, fall to step 5
       - If present: create AnthropicLLM (smart) + AnthropicLLM(haiku) (fast)
  3. If "openai":
       - Check process.env.OPENAI_API_KEY
       - If missing: log warning, fall to step 5
       - If present: create OpenAILLM (smart) + OpenAILLM(mini) (fast)
  4. If "ollama":
       - Probe http://localhost:11434/api/tags
       - If unreachable: log warning, fall to step 5
       - If reachable: create OllamaLLM (smart=fast=same model)
  5. Claude Code CLI fallback:
       - Check `which claude` in PATH
       - If found: create ClaudeCodeLLM (smart=fast=same)
       - Note: 5-15s latency per call, suitable for dev only
  6. Final fallback: MockLLM (returns "[LLM unavailable]")

  All transitions logged to console.warn with reason.
```

---

## 6. Database Schema Extension

**Owner: Service Developer C**

All new tables live in `intelligence.db` (separate from WCDB, which is read-only). Created via `better-sqlite3` in the main process.

```sql
-- Discussion mode sessions (3-round guided discussion)
CREATE TABLE IF NOT EXISTS coach_discussion (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact TEXT NOT NULL,
    incoming_message TEXT NOT NULL,
    rounds TEXT NOT NULL DEFAULT '[]',        -- JSON array of DiscussionRound
    strategy_summary TEXT,                     -- AI-generated after discussion
    status TEXT DEFAULT 'active',              -- active | completed | cancelled
    guide_questions TEXT,                      -- JSON array of strings
    is_complex INTEGER DEFAULT 0,
    complexity_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_discussion_contact
    ON coach_discussion(contact);
CREATE INDEX IF NOT EXISTS idx_discussion_status
    ON coach_discussion(status);
CREATE INDEX IF NOT EXISTS idx_discussion_contact_msg_status
    ON coach_discussion(contact, incoming_message, status);

-- Per-contact preferences (star, ignore, priority)
CREATE TABLE IF NOT EXISTS contact_preferences (
    contact_name TEXT PRIMARY KEY,
    is_starred INTEGER DEFAULT 0,
    is_ignored INTEGER DEFAULT 0,
    priority INTEGER DEFAULT 0,               -- 0=normal, 1=high, -1=low
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contact_pref_starred
    ON contact_preferences(is_starred) WHERE is_starred = 1;
CREATE INDEX IF NOT EXISTS idx_contact_pref_ignored
    ON contact_preferences(is_ignored) WHERE is_ignored = 1;

-- Cross-platform identity aliases (wxid -> display name)
CREATE TABLE IF NOT EXISTS identity_aliases (
    alias TEXT PRIMARY KEY,
    canonical_name TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_identity_canonical
    ON identity_aliases(canonical_name);

-- Media enrichment cache (avoid re-processing same media)
CREATE TABLE IF NOT EXISTS enriched_cache (
    cache_key TEXT PRIMARY KEY,               -- md5(media_type + localId/url)
    media_type TEXT NOT NULL,                  -- image | voice | video | article
    processed_content TEXT NOT NULL,           -- the text result
    base64_data TEXT,                          -- for images (nullable, large)
    metadata TEXT DEFAULT '{}',                -- JSON extra info
    created_at TEXT NOT NULL,
    expires_at TEXT                            -- optional TTL
);
CREATE INDEX IF NOT EXISTS idx_enriched_cache_type
    ON enriched_cache(media_type);

-- Daily briefing history
CREATE TABLE IF NOT EXISTS daily_briefing (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL UNIQUE,                 -- ISO date (YYYY-MM-DD)
    items TEXT NOT NULL DEFAULT '[]',          -- JSON array of BriefingItem
    summary TEXT,                              -- LLM-generated 1-sentence summary
    generated_at TEXT NOT NULL,
    model_used TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_briefing_date
    ON daily_briefing(date);

-- Relationships (social graph edges)
CREATE TABLE IF NOT EXISTS relationships (
    contact_name TEXT PRIMARY KEY,
    relationship_type TEXT DEFAULT 'acquaintance',
    closeness REAL DEFAULT 0.0,
    communication_style TEXT DEFAULT '',
    topics TEXT DEFAULT '[]',                  -- JSON array
    dynamics TEXT DEFAULT '',
    last_updated TEXT DEFAULT ''
);

-- Contacts (social graph nodes)
CREATE TABLE IF NOT EXISTS contacts (
    name TEXT PRIMARY KEY,
    platform TEXT DEFAULT '',
    aliases TEXT DEFAULT '[]',                 -- JSON array
    relationship TEXT DEFAULT '',
    first_seen TEXT DEFAULT '',
    last_seen TEXT DEFAULT '',
    message_count INTEGER DEFAULT 0,
    metadata TEXT DEFAULT '{}'                 -- JSON object
);

-- Personality profile (key-value store)
CREATE TABLE IF NOT EXISTS personality (
    key TEXT PRIMARY KEY,
    value TEXT DEFAULT ''
);

-- Per-contact communication style overrides
CREATE TABLE IF NOT EXISTS per_contact_style (
    contact_name TEXT PRIMARY KEY,
    style TEXT DEFAULT ''
);

-- Coach log (debug & feedback tracking)
CREATE TABLE IF NOT EXISTS coach_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    contact TEXT NOT NULL,
    incoming_message TEXT NOT NULL,
    relationship_context TEXT DEFAULT '',
    history_context TEXT DEFAULT '',
    personality_context TEXT DEFAULT '',
    system_prompt TEXT DEFAULT '',
    user_prompt TEXT DEFAULT '',
    llm_response TEXT DEFAULT '',
    parsed_suggestions TEXT DEFAULT '[]',
    model_used TEXT DEFAULT '',
    duration_ms INTEGER DEFAULT 0,
    is_group INTEGER DEFAULT 0,
    call_type TEXT DEFAULT 'suggest'           -- suggest | analyze | discuss | discuss_reply
);
CREATE INDEX IF NOT EXISTS idx_coach_log_ts
    ON coach_log(timestamp);

-- Coach feedback (user ratings on suggestions)
CREATE TABLE IF NOT EXISTS coach_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    log_id INTEGER NOT NULL,
    suggestion_index INTEGER NOT NULL,
    rating TEXT NOT NULL,                      -- good | bad | rewrite
    user_rewrite TEXT DEFAULT '',
    contact TEXT DEFAULT '',
    FOREIGN KEY (log_id) REFERENCES coach_log(id)
);

-- Coach config (key-value overrides)
CREATE TABLE IF NOT EXISTS coach_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
```

### Schema Notes

- `intelligence.db` is created at `{userData}/weflow-intelligence/intelligence.db`
- File permissions: `0o600` (owner-only, contains personal data)
- All JSON columns use `JSON.stringify()` / `JSON.parse()` -- no SQLite JSON functions needed
- `enriched_cache.base64_data` can be large (5MB+ for images); consider separate blob storage if DB exceeds 500MB
- `better-sqlite3` is synchronous -- all calls run in the main process without worker threads (sufficient for <100ms queries)

---

## 7. New Pages Design

**Owner: Frontend Developer**

### 7.1 AssistantPage -- Three-Column Layout

```
┌─────────────────────────────────────────────────────────────────────┐
│  Communication Assistant                              [Settings] [?]│
├──────────────┬──────────────────────────┬──────────────────────────┤
│              │                          │                          │
│  Contacts    │   Conversation Context   │   Reply Suggestions      │
│  List        │                          │                          │
│              │                          │                          │
│  ┌────────┐  │  ┌────────────────────┐  │  ┌────────────────────┐  │
│  │ ★ 老板  │  │  │ [老板] 那个方案你   │  │  │ Strategy: safe     │  │
│  │  HIGH   │  │  │ 看了吗？明天开会    │  │  │                    │  │
│  │  2m ago │  │  │ 前给我个反馈       │  │  │ "好的老板，方案我   │  │
│  ├────────┤  │  │                    │  │  │  已经看了，正在..."  │  │
│  │ 小王    │  │  │ [我] 好的老板      │  │  │                    │  │
│  │  MED    │  │  │                    │  │  │ Reason: 稳妥回应... │  │
│  │  15m    │  │  │ [老板] 这次要注意   │  │  ├────────────────────┤  │
│  ├────────┤  │  │ 竞品分析部分       │  │  │ Strategy: warm     │  │
│  │ 群聊A   │  │  │                    │  │  │                    │  │
│  │  LOW    │  │  │ [我] 明白          │  │  │ "老板，方案我仔细   │  │
│  │  1h     │  │  │                    │  │  │  看过了，特别是..."  │  │
│  ├────────┤  │  │ --- 今天 ---       │  │  ├────────────────────┤  │
│  │ 妈妈    │  │  │                    │  │  │ Strategy: firm     │  │
│  │  MED    │  │  │ [老板] 那个方案你   │  │  │                    │  │
│  │  30m    │  │  │ 看了吗？明天开会    │  │  │ "方案看过了，我觉   │  │
│  │         │  │  │ 前给我个反馈       │  │  │  得有几个点需要..."  │  │
│  │  ...    │  │  │                    │  │  │                    │  │
│  │         │  │  │ ☑ Select messages  │  │  │ [Copy] [讨论]      │  │
│  └────────┘  │  │ for AI context     │  │  └────────────────────┘  │
│              │  └────────────────────┘  │                          │
│  [Starred]   │                          │  ┌────────────────────┐  │
│  [All]       │  Context Summary:        │  │ Discussion Panel   │  │
│  [Ignored]   │  "老板催方案反馈，       │  │ (expandable)       │  │
│              │   需要明天前回复"         │  │                    │  │
│              │                          │  │ Round 1: ...       │  │
│              │                          │  │ Round 2: ...       │  │
│              │                          │  │ [Generate Replies] │  │
│              │                          │  └────────────────────┘  │
├──────────────┴──────────────────────────┴──────────────────────────┤
│  Status: 5 pending | 2 high | Model: claude-sonnet-4 | Last: 30s  │
└─────────────────────────────────────────────────────────────────────┘
```

**Column widths:** Left 20% | Center 40% | Right 40% (responsive, min-width breakpoints)

**Left column (Contacts):**
- Sorted by urgency (high -> medium -> low), then timestamp
- Star/ignore toggle per contact
- Filter tabs: Starred / All / Ignored
- Badge: urgency level + time since message

**Center column (Conversation Context):**
- Paginated conversation history (newest at bottom)
- Checkboxes for user-selected messages (AI context override)
- Auto-generated 1-line context summary
- Voice messages show transcribed text inline
- Images show thumbnail + description

**Right column (Reply Suggestions):**
- 3 suggestions (safe/warm/firm) with reasoning
- Copy button per suggestion
- Discussion panel (collapsible) for complex messages
- Feedback: thumbs up/down + rewrite per suggestion

### 7.2 GraphPage

```
┌─────────────────────────────────────────────────────────────────────┐
│  Social Graph                                         [Filter] [?] │
├─────────────────────────────────────┬───────────────────────────────┤
│                                     │                               │
│     Interactive Graph                │  Contact Detail               │
│     (force-directed D3/ECharts)      │                               │
│                                     │  Name: 老板                   │
│         [妈妈]---[我]---[老板]       │  Type: colleague (上级)       │
│            \      |      /          │  Closeness: 0.7/1.0           │
│            [小王] | [小李]           │  Style: formal                │
│                   |                 │  Topics: 项目管理, 方案评审    │
│              [群聊-项目组]            │  Messages: 342                │
│                                     │  Last: 2h ago                 │
│                                     │                               │
│                                     │  Recent:                      │
│                                     │    "那个方案你看了吗？"        │
│                                     │    "好的老板"                  │
│                                     │                               │
├─────────────────────────────────────┴───────────────────────────────┤
│  Stats: 45 contacts | 12 groups | Avg closeness: 0.45              │
└─────────────────────────────────────────────────────────────────────┘
```

### 7.3 BriefingPage

```
┌─────────────────────────────────────────────────────────────────────┐
│  Daily Briefing                              2026-04-06  [Refresh] │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Summary: 今天有3条未回复消息需要处理，2个快递即将送达。              │
│                                                                     │
│  ┌─ URGENT ────────────────────────────────────────────────────┐   │
│  │ [!] 老板 催方案反馈 (2h ago)                     [Go Reply] │   │
│  │ [!] 小王 问项目排期 (45m ago)                    [Go Reply] │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌─ REMINDERS ─────────────────────────────────────────────────┐   │
│  │ [*] 顺丰快递 预计今天送达                                    │   │
│  │ [*] 明天 14:00 项目评审会                                    │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌─ INSIGHTS ──────────────────────────────────────────────────┐   │
│  │ [i] 本周与老板沟通频率上升 30%，主要围绕方案评审             │   │
│  │ [i] 群聊"项目组"活跃度下降，上次发言 3 天前                  │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 7.4 CoachLogPage (Debug)

```
┌─────────────────────────────────────────────────────────────────────┐
│  Coach Log (Debug)                          [Export] [Clear] [?]   │
├─────────────────────────────────────────────────────────────────────┤
│  Filter: [All Types v] [All Contacts v] [Last 7 days v] [Search]  │
├─────┬──────┬────────┬──────┬───────┬────────┬───────────┬──────────┤
│ ID  │ Time │Contact │ Type │ Model │ Dur(ms)│ Message   │ Actions  │
├─────┼──────┼────────┼──────┼───────┼────────┼───────────┼──────────┤
│ 42  │14:30 │ 老板   │suggest│sonnet │  1230  │ 那个方案..│ [Detail] │
│ 41  │14:29 │ 老板   │analyze│sonnet │   890  │ 那个方案..│ [Detail] │
│ 40  │14:15 │ 小王   │suggest│haiku  │   450  │ 排期确认..│ [Detail] │
│ 39  │13:00 │ 妈妈   │suggest│sonnet │  1100  │ 晚上回来..│ [Detail] │
├─────┴──────┴────────┴──────┴───────┴────────┴───────────┴──────────┤
│                                                                     │
│  Detail (ID: 42)                                                    │
│  ┌─ System Prompt ───────────────────────────────────────────────┐ │
│  │ 你是一个职场高情商沟通教练...                                  │ │
│  └───────────────────────────────────────────────────────────────┘ │
│  ┌─ User Prompt ─────────────────────────────────────────────────┐ │
│  │ 联系人：老板 (colleague, closeness 0.7)                       │ │
│  │ 消息：那个方案你看了吗？明天开会前给我个反馈                    │ │
│  │ 历史：...                                                     │ │
│  └───────────────────────────────────────────────────────────────┘ │
│  ┌─ LLM Response ────────────────────────────────────────────────┐ │
│  │ REPLY: 好的老板，方案我已经看了...                             │ │
│  │ REASON: ...                                                   │ │
│  └───────────────────────────────────────────────────────────────┘ │
│  ┌─ Parsed Suggestions ─────────────────────────────────────────┐  │
│  │ [1] safe: "好的老板，方案我已经看了..."  confidence: 0.85     │  │
│  │ [2] warm: "老板，方案我仔细看过了..."    confidence: 0.80     │  │
│  │ [3] firm: "方案看过了，我觉得有几个..."  confidence: 0.75     │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 7.5 Content Hub Page (ContentHubPage) — 内容中心

**Purpose**: Aggregate all rich media content (official account articles, video channels, links, files) shared across all conversations into a single searchable, filterable view with AI analysis capability.

**Route**: `/content`

### Layout

```
┌──────────────┬─────────────────────────────────────────────────┐
│  Filter Panel │  Content Cards (scrollable feed)                │
│  (240px)      │                                                 │
│               │  ┌─────────────────────────────────────────────┐│
│  TYPE         │  │ [公众号] 深度学习在金融领域的应用            ││
│  ☑ 公众号     │  │ 来源: 王泽旺 → Wise群 · 3天前               ││
│  ☑ 视频号     │  │ 摘要: AI量化交易的三种主流方案...            ││
│  ☑ 链接       │  │ 关联上下文: 王泽旺正在研究AI应用             ││
│  ☑ 文件       │  │ [AI深度分析] [原文链接] [收藏] [忽略]        ││
│  ☐ 小程序     │  └─────────────────────────────────────────────┘│
│               │                                                 │
│  SOURCE       │  ┌─────────────────────────────────────────────┐│
│  ☑ 好友私聊   │  │ [视频号] 极视角港股上市现场直播              ││
│  ☑ 群聊       │  │ 来源: 刘富胜 · 极视角技术群 · 1周前         ││
│  ☐ 朋友圈     │  │ ⚠ 关联: 你与极视角存在股权纠纷              ││
│               │  │ [AI深度分析] [查看] [收藏]                   ││
│  CONTACT      │  └─────────────────────────────────────────────┘│
│  🔍 搜索联系人│                                                 │
│               │  ┌─────────────────────────────────────────────┐│
│  TIME         │  │ [文件] 工商档案委托查询合同（黄河）.doc      ││
│  最近7天  ▼   │  │ 来源: （华商）何楚琪咨询服务群 · 2天前      ││
│               │  │ 文件大小: 245KB · Word文档                   ││
│               │  │ [AI分析内容] [下载] [收藏]                   ││
│               │  └─────────────────────────────────────────────┘│
└──────────────┴─────────────────────────────────────────────────┘
```

### Data Sources (reuse existing WeFlow parsing)

| Content Type | WCDB Detection | WeFlow Service | Fields Available |
|-------------|---------------|----------------|-----------------|
| 公众号文章 | type49 xmlType 5/49, `gh_` prefix | `chatService.ts` line ~4789 | title, desc, thumbnail, sourceUsername, sourceName |
| 视频号 | type49 xmlType 51 | `chatService.ts` line ~4721 | coverUrl, duration, creatorNickname, creatorAvatar |
| 链接 | type49 xmlType 5/49 (non-gh_) | `chatService.ts` | title, url, description, thumbnail |
| 文件 | type49 xmlType 6 | `chatService.ts` | fileName, fileSize, fileExtension |
| 小程序 | type49 xmlType 33/36 | `chatService.ts` | appName, title, url, thumbnail |

### AI Analysis Context Assembly (when user clicks "AI深度分析")

```
Click "AI深度分析" on a content card
   │
   ├─ 1. Content Extraction
   │     ├─ 公众号: ⚠️ 不能用fetch（服务器返回验证页面）→ 使用 AutoCLI (github.com/nashsu/AutoCLI) 提取正文 → LLM summarize (≤1500 chars)
   │     ├─ 视频号: cover description + creator info (video not downloadable)
   │     ├─ 链接: fetch page content → LLM summarize
   │     ├─ 文件: extract text (doc/pdf via pymudf or textract) → LLM summarize
   │     └─ 小程序: title + description only
   │
   ├─ 2. Sender Context (from graphService)
   │     ├─ Who sent it: display name, relationship type, closeness score
   │     ├─ Communication style with sender
   │     └─ Shared topics history
   │
   ├─ 3. Conversation Context (from chatService)
   │     ├─ Messages before/after this content in the same chat
   │     ├─ Why did they share this? (surrounding discussion)
   │     └─ Group context if from group chat
   │
   ├─ 4. Topic Correlation (cross-conversation)
   │     ├─ Has user discussed this topic in other chats?
   │     ├─ Related content from other sources
   │     └─ User's known interests/concerns related to topic
   │
   └─ 5. LLM Analysis
         ├─ Content summary
         ├─ Why this person shared it with you (motivation analysis)
         ├─ Relevance to your situation
         └─ Suggested response or action

System prompt for content analysis:
"你是一个信息分析助手。用户收到了来自社交网络的分享内容。
请基于内容本身、发送者与用户的关系、以及对话上下文，分析：
1. 内容核心要点（3句话以内）
2. 对方分享这个内容的可能动机
3. 这个内容与用户当前处境的关联
4. 建议的回应方式"
```

### New Files Required

| File | Role | Description |
|------|------|-------------|
| `electron/services/intelligence/contentHubService.ts` | Service Dev A | Aggregate + index content from WCDB |
| `src/pages/ContentHubPage.tsx` | Frontend Dev | Content hub UI with filters |
| `src/pages/ContentHubPage.scss` | Frontend Dev | Styles |
| `src/stores/contentHubStore.ts` | Frontend Dev | Zustand store for filter state, content list |

### IPC Channels

```typescript
'intel:getContentFeed': (filters: ContentFilter) => Promise<ContentItem[]>
'intel:analyzeContent': (contentId: string) => Promise<ContentAnalysis>
'intel:bookmarkContent': (contentId: string) => Promise<void>
'intel:ignoreContent': (contentId: string) => Promise<void>
```

---

## 8. Configuration

### electron-store IntelligenceConfig

```typescript
// Extends existing ConfigSchema in electron/services/config.ts

interface IntelligenceConfig {
  // LLM provider settings
  llmProvider: 'anthropic' | 'openai' | 'ollama' | 'claude-code' | 'mock'
  llmModel: string                    // e.g. "claude-sonnet-4-20250514"
  llmFastModel: string                // e.g. "claude-haiku-4-5-20251001"
  llmApiKey: string                   // encrypted via safeStorage
  llmBaseUrl: string                  // for Ollama or custom endpoints

  // Intelligence features toggle
  intelligenceEnabled: boolean        // master switch
  replyCoachEnabled: boolean          // reply suggestions
  discussionEnabled: boolean          // 3-round discussion mode
  briefingEnabled: boolean            // daily briefing generation
  graphEnabled: boolean               // social graph analysis

  // Media processing
  mediaVisionEnabled: boolean         // image description via Vision LLM
  mediaVideoEnabled: boolean          // video keyframe + audio analysis
  mediaArticleFetchEnabled: boolean   // fetch & summarize shared articles
  mediaMaxImageSizeMB: number         // default: 5
  mediaKeyframeCount: number          // default: 4
  mediaKeyframeIntervalSec: number    // default: 5

  // Discussion mode
  discussionMaxRounds: number         // default: 3
  discussionAutoAnalyze: boolean      // auto-analyze complexity on new message

  // Briefing
  briefingAutoGenerate: boolean       // auto-generate daily at configured time
  briefingTime: string                // "08:00" (HH:MM format)

  // Debug
  coachLogEnabled: boolean            // log all LLM calls to coach_log table
  coachLogRetentionDays: number       // auto-cleanup, default: 30
}

// Default values
const INTELLIGENCE_DEFAULTS: IntelligenceConfig = {
  llmProvider: 'mock',
  llmModel: '',
  llmFastModel: '',
  llmApiKey: '',
  llmBaseUrl: '',

  intelligenceEnabled: false,
  replyCoachEnabled: true,
  discussionEnabled: true,
  briefingEnabled: true,
  graphEnabled: true,

  mediaVisionEnabled: true,
  mediaVideoEnabled: false,          // off by default (heavy)
  mediaArticleFetchEnabled: true,
  mediaMaxImageSizeMB: 5,
  mediaKeyframeCount: 4,
  mediaKeyframeIntervalSec: 5,

  discussionMaxRounds: 3,
  discussionAutoAnalyze: true,

  briefingAutoGenerate: false,
  briefingTime: '08:00',

  coachLogEnabled: true,
  coachLogRetentionDays: 30,
}
```

---

## 9. One -> WeFlow Module Mapping

### Complete Migration Table

| One Python File | WeFlow TypeScript File | Change Level | Description |
|----------------|----------------------|-------------|-------------|
| `intelligence/reply_coach.py` | `electron/services/intelligence/replyCoachService.ts` | **Full rewrite** | ReplyCoach class -> TypeScript. Context assembly, suggest(), urgency classification, heuristic fallback. |
| `intelligence/reply_coach.py` (discussion) | `electron/services/intelligence/discussionService.ts` | **Full rewrite** | Discussion mode: analyze_complexity(), discuss(), discuss_reply(). 3-round flow + prompts. |
| `intelligence/models.py` | `electron/services/intelligence/intelligenceDB.ts` | **Full rewrite** | IntelligenceDB -> better-sqlite3. All tables: contacts, relationships, personality, coach_*, identity_aliases, contact_preferences. |
| `intelligence/graph.py` | `electron/services/intelligence/socialGraphService.ts` | **Full rewrite** | SocialGraph: get_relationship(), get_contact(), cross-platform identity matching. |
| `intelligence/personality.py` | `electron/services/intelligence/personalityService.ts` | **Full rewrite** | PersonalityMirror: get_profile(), per_contact_style, formality analysis. |
| `intelligence/briefing.py` | `electron/services/intelligence/briefingService.ts` | **Full rewrite** | BriefingGenerator: unreplied detection, delivery tracking, insights, LLM summary. |
| `intelligence/sensevoice.py` | *Not needed* | **Skip** | WeFlow already has `voiceTranscribeService.ts` with sherpa-onnx. Reuse as-is. |
| `intelligence/pua_detector.py` | `electron/services/intelligence/puaDetectorService.ts` | **Full rewrite** | PUA detection: 6 manipulation patterns, scoring. Lower priority (Phase 5+). |
| `intelligence/social_advisor.py` | `electron/services/intelligence/socialAdvisorService.ts` | **Full rewrite** | Social advisor: goal-oriented group scoring, external recommendations. Phase 5+. |
| `intelligence/growth_advisor.py` | `electron/services/intelligence/growthAdvisorService.ts` | **Full rewrite** | Growth advisor. Phase 5+. |
| `intelligence/purchase_advisor.py` | *Deferred* | **Defer** | Purchase advisor needs Taobao data, not available in WeFlow. |
| `intelligence/fingerprint.py` | *Deferred* | **Defer** | Data fingerprinting, not needed for MVP. |
| `intelligence/metrics.py` | *Deferred* | **Defer** | Intelligence metrics dashboard. |
| `llm/backend.py` | `electron/services/intelligence/llmService.ts` | **Full rewrite** | LLMBackend interface + AnthropicLLM, OpenAILLM, OllamaLLM, ClaudeCodeLLM, MockLLM. Vision + multimodal support. |
| `llm/router.py` | `electron/services/intelligence/llmRouter.ts` | **Full rewrite** | LLMRouter: fast/smart/vision selection, auto-fallback logic, create_router_from_config(). |
| `processing/rich_media.py` | `electron/services/intelligence/mediaContextService.ts` | **Partial rewrite** | Article fetch (SSRF protection, BS4->cheerio), video processing (ffmpeg calls). Image handling delegates to existing imageDecryptService. |
| `processing/pipeline.py` | *Not needed* | **Skip** | T2->T3 enrichment pipeline. WeFlow uses WCDB directly, no JSONL. |
| `processing/summarizer.py` | Inline in `replyCoachService.ts` | **Inline** | Conversation summary: 1-line LLM summarize(). Small enough to inline. |
| `processing/transformers.py` | *Not needed* | **Skip** | Record transformers for JSONL processing. |
| `parsers/schema.py` | `electron/services/intelligence/types.ts` | **New types file** | ContextBundle, ReplySuggestion, PendingMessage, etc. No OneRecord/EnrichedRecord (WeFlow uses WCDBMessage). |
| `parsers/media.py` | Inline in `mediaContextService.ts` | **Inline** | Media type detection, XML parsing. WeFlow chatService already parses most XML. |
| `parsers/text.py` | *Not needed* | **Skip** | Text parsing for JSONL records. |
| `utils/prompt.py` | `electron/services/intelligence/promptUtils.ts` | **Partial rewrite** | escape_for_prompt(), urgency regex patterns. |
| `utils/wechat_files.py` | *Not needed* | **Skip** | WeFlow already handles file path conventions. |
| `utils/wechat_video.py` | Inline in `mediaContextService.ts` | **Inline** | ffmpeg audio extract + keyframe extract. WeFlow already has ffmpeg-static. |
| `web/app.py` (coach endpoints) | `electron/main.ts` (IPC handlers) | **IPC rewrite** | REST endpoints -> ipcMain.handle() handlers. Same API shape, different transport. |
| `web/realtime.py` | *Integrate with existing* | **Integrate** | WebSocket events -> WeFlow's existing messagePushService for real-time updates. |
| `storage/index.py` | *Not needed* | **Skip** | JSONL/FTS index. WeFlow uses WCDB directly via wcdbService. |
| `storage/enriched.py` | *Not needed* | **Skip** | Enriched record store. WeFlow caches in intelligence.db. |

### New Files (no One equivalent)

| WeFlow TypeScript File | Description |
|----------------------|-------------|
| `electron/services/intelligence/index.ts` | Intelligence service barrel export + initialization |
| `electron/services/intelligence/contextAssembly.ts` | 7-step context assembly pipeline (extracted from replyCoach for reuse) |
| `electron/services/intelligence/urgencyClassifier.ts` | Regex-based urgency classification (high/medium/low) |
| `src/pages/AssistantPage.tsx` | Communication Assistant 3-column layout |
| `src/pages/GraphPage.tsx` | Social graph visualization (ECharts force-directed) |
| `src/pages/BriefingPage.tsx` | Daily briefing display |
| `src/pages/CoachLogPage.tsx` | Debug: LLM call log viewer |
| `src/stores/intelligenceStore.ts` | Zustand store for intelligence state |

---

## 10. Modules NOT Being Migrated

| One Module | Reason |
|-----------|--------|
| `chain/` (attestation, claims, merkle, prover) | ZK proof system requires Circom + snarkjs (Node.js toolchain). Not part of communication assistant. Separate project scope. |
| `crypto/encrypt.py` | WeFlow uses electron `safeStorage` + its own encryption for WCDB keys. No need for Python AES-256-GCM. |
| `connectors/` (protocol, loader, builtins) | OneConnector plugin system is for data collection from 10+ platforms. WeFlow reads directly from WCDB -- no connector layer needed. |
| `sync/rclone.py` | Cloud sync is an infrastructure concern, not part of intelligence features. WeFlow has no rclone equivalent. |
| `query/rag.py` | RAG pipeline needs ChromaDB + embeddings. May be added later as a separate feature. Not needed for reply coaching. |
| `storage/vault.py` | Tier 1 raw file storage. WeFlow reads from WeChat's own file system. |
| `storage/embedder.py` | BGE-M3 / OpenAI embeddings. May be added with RAG. Not needed for MVP. |
| `storage/vector_db.py` | ChromaDB vector search. Same as above. |
| `storage/pipeline.py` | Indexing pipeline for JSONL. WeFlow uses WCDB. |
| `collectors/` | Data collection from platforms. WeFlow has direct WCDB access. |
| `hooks/registry.py` | Hook system for pipeline events. Not needed in Electron single-process model. |
| `web/app.py` (non-coach endpoints) | REST API for data browsing, search, export. WeFlow has its own pages + IPC for these. |
| `web/mcp.py` | MCP stdio server for AI tool use. Separate concern from in-app intelligence. |
| `gateway/gateway.py` | SSE gateway for real-time data. WeFlow has messagePushService. |
| `intelligence/fingerprint.py` | Data fingerprinting for ZK proofs. Not needed for communication assistant. |
| `intelligence/metrics.py` | Intelligence metrics. Defer to Phase 5+. |
| `intelligence/purchase_advisor.py` | Requires Taobao/e-commerce data not available in WeFlow. |

---

## 11. Autonomous Execution Rules

Decision rules for unattended 10-hour agent runs. When an agent encounters an ambiguous situation, follow these rules instead of stopping to ask:

### Type Errors

```
IF: TypeScript compilation error (tsc --noEmit fails)
THEN: Self-fix
  - Read the error message
  - Fix the type mismatch
  - Re-run tsc --noEmit to verify
  - If fix introduces new errors, revert and try alternative approach
DO NOT: Suppress with `any` type or `@ts-ignore` (except for third-party lib gaps)
```

### Test Failures

```
IF: Test fails after code change
THEN: Self-fix and rerun
  - Read test failure output
  - Determine if test is wrong (testing old behavior) or code is wrong
  - Fix the appropriate side
  - Rerun the specific test file
  - If still failing after 3 attempts, log the issue and continue
DO NOT: Delete or skip tests
```

### Architecture Ambiguity

```
IF: Unclear how a feature should be implemented
THEN: Refer to this document (ARCHITECTURE.md)
  - Check the relevant section for your role
  - Check the module mapping table
  - Check the data structures and interfaces
  - If still unclear, follow the One Python implementation pattern
  - Log the decision in a comment: "// ARCH: chose X because Y"
DO NOT: Invent new architecture patterns or add new dependencies
```

### Dependency Conflicts

```
IF: npm dependency version conflict
THEN: Choose compatible version and log
  - Check package.json for existing version constraints
  - Use the version compatible with existing deps
  - If new dependency needed:
    - Prefer deps already in node_modules (transitive)
    - Choose the most popular/maintained option
    - Log: "// DEP: added {package}@{version} for {reason}"
DO NOT: Upgrade major versions of existing deps without explicit approval
```

### Phase Completion

```
IF: Current phase completed (all files written, types compile, tests pass)
THEN: Auto-advance to next phase
  - Run full typecheck: tsc --noEmit
  - Run relevant tests
  - Commit with message: "Phase N complete: {summary}"
  - Begin next phase from module mapping table
DO NOT: Skip phases or work on Phase N+2 before Phase N+1
```

### Module Completion

```
IF: Single module completed (e.g., llmService.ts)
THEN: Auto-run tests
  - Create test file if none exists: __tests__/{module}.test.ts
  - Write basic smoke tests (instantiation, mock calls, error handling)
  - Run tests
  - Fix any failures
  - Move to next module in the phase
```

### All Complete

```
IF: All phases completed
THEN: Generate report
  - List all files created/modified
  - List all tests created and their pass/fail status
  - List any deferred decisions (logged with // ARCH: or // DEP:)
  - List any known issues or TODO items
  - Commit final state
```

### Guardrails (NEVER do these autonomously)

```
NEVER:
  - Delete existing WeFlow files outside electron/services/intelligence/
  - Modify existing WeFlow services (chatService, wcdbService, etc.) without explicit instruction
  - Change electron/main.ts beyond adding IPC handlers for intelligence features
  - Push to remote
  - Modify package.json beyond adding dev/test dependencies
  - Create Python files or subprocess bridges (B Plan = TypeScript only)
  - Add more than 3 new npm dependencies per phase without logging reason
```
