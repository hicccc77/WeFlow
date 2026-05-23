import { describe, expect, it } from 'vitest'
import { writeChatLabJsonlStream, writeHtmlStream, writeTxtStream } from './streamingWriters'
import type { MessageStreamRow } from './messageStream'

class MemorySink {
  chunks: string[] = []
  async write(chunk: string): Promise<void> {
    this.chunks.push(chunk)
  }
  async end(): Promise<void> {}
  text(): string {
    return this.chunks.join('')
  }
}

async function* rows(): AsyncGenerator<MessageStreamRow> {
  yield { localId: 1, serverId: 11, createTime: 1, localType: 1, content: 'hello', senderUsername: 'me', isSend: true }
  yield { localId: 2, serverId: 12, createTime: 2, localType: 1, content: '<b>&"', senderUsername: 'you', isSend: false }
}

async function* systemRows(): AsyncGenerator<MessageStreamRow> {
  yield {
    localId: 3,
    serverId: 13,
    createTime: 3,
    localType: 10000,
    content: '<sysmsg><sysmsgtemplate><content_template><plain><![CDATA["$username$"邀请"$names$"加入了群聊]]></plain><link_list><link name="username"><memberlist><member><nickname><![CDATA[张三]]></nickname></member></memberlist></link><link name="names"><memberlist><member><nickname><![CDATA[李四]]></nickname></member><member><nickname><![CDATA[王五]]></nickname></member></memberlist></link></link_list></content_template></sysmsgtemplate></sysmsg>',
    senderUsername: 'room',
    isSend: false
  }
}

async function* qrcodeSystemRows(): AsyncGenerator<MessageStreamRow> {
  yield {
    localId: 4,
    serverId: 14,
    createTime: 4,
    localType: 10000,
    content: '<sysmsg><sysmsgtemplate><content_template><plain><![CDATA["$adder$"通过扫描"$from$"分享的二维码加入群聊]]></plain><link_list><link name="adder"><memberlist><member><nickname><![CDATA[新成员]]></nickname></member></memberlist></link><link name="from"><memberlist><member><nickname><![CDATA[分享者]]></nickname></member></memberlist></link></link_list></content_template></sysmsgtemplate></sysmsg>',
    senderUsername: 'room',
    isSend: false
  }
}

describe('streaming writers', () => {
  it('writes txt without buffering the full stream', async () => {
    const sink = new MemorySink()
    await writeTxtStream(rows(), sink, {
      getSenderName: (row) => row.isSend ? '我' : '对方',
      formatTimestamp: (ts) => `t${ts}`,
      flushEvery: 1
    })
    expect(sink.chunks.length).toBeGreaterThan(1)
    expect(sink.text()).toContain("t1 '我'\nhello\n\n")
    expect(sink.text()).toContain("t2 '对方'\n<b>&\"\n\n")
  })

  it('escapes html while writing message chunks', async () => {
    const sink = new MemorySink()
    await writeHtmlStream(rows(), sink, {
      sessionName: 'A&B',
      getSenderName: (row) => row.senderUsername,
      formatTimestamp: (ts) => `t${ts}`,
      flushEvery: 1
    })
    const text = sink.text()
    expect(text).toContain('<title>A&amp;B</title>')
    expect(text).toContain('&lt;b&gt;&amp;&quot;')
    expect(text).not.toContain('<b>&"')
  })

  it('writes valid jsonl records split across chunks', async () => {
    const sink = new MemorySink()
    await writeChatLabJsonlStream(rows(), sink, {
      sessionName: 'room',
      getSenderName: (row) => row.senderUsername,
      flushEvery: 1
    })
    const lines = sink.text().trim().split(/\r?\n/)
    expect(lines.length).toBe(4)
    expect(JSON.parse(lines[0])._type).toBe('chatlab')
    expect(JSON.parse(lines[2]).content).toBe('hello')
    expect(JSON.parse(lines[3]).content).toBe('<b>&"')
  })

  it('expands system message templates while streaming', async () => {
    const sink = new MemorySink()
    await writeChatLabJsonlStream(systemRows(), sink, {
      sessionName: 'room',
      getSenderName: (row) => row.senderUsername,
      flushEvery: 1
    })
    const message = JSON.parse(sink.text().trim().split(/\r?\n/)[2])
    expect(message.content).toBe('"张三"邀请"李四、王五"加入了群聊')
    expect(message.content).not.toContain('$username$')
    expect(message.content).not.toContain('$names$')
  })

  it('expands QR code join templates while streaming', async () => {
    const sink = new MemorySink()
    await writeTxtStream(qrcodeSystemRows(), sink, {
      getSenderName: (row) => row.senderUsername,
      flushEvery: 1
    })
    expect(sink.text()).toContain('"新成员"通过扫描"分享者"分享的二维码加入群聊')
    expect(sink.text()).not.toContain('$adder$')
    expect(sink.text()).not.toContain('$from$')
  })
})
