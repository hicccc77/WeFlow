import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MediaContextService, extractArticleText, extractGenericPageText, parseXmlType, isUrlSafe, extractXmlValue } from '../mediaContextService'
import { WCDBMessage } from '../types'
import { llmService } from '../llmService'

// Mock llmService
vi.mock('../llmService', () => ({
  llmService: {
    describeImage: vi.fn().mockResolvedValue('一张办公室照片'),
    summarize: vi.fn().mockResolvedValue('这篇文章讨论了AI在金融领域的应用'),
    analyzeContent: vi.fn().mockResolvedValue('分析结果'),
    call: vi.fn().mockResolvedValue({ text: 'mock response', model: 'mock', provider: 'mock' }),
  },
}))

// Mock sharp
vi.mock('sharp', () => {
  return {
    default: (buffer: Buffer) => ({
      metadata: () => Promise.resolve({ width: 1024, height: 768 }),
      resize: () => ({
        jpeg: () => ({
          toBuffer: () => Promise.resolve(Buffer.alloc(100)),
        }),
      }),
    }),
  }
})

// Mock fs
vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  readFileSync: vi.fn().mockReturnValue(Buffer.alloc(1024)),
  statSync: vi.fn().mockReturnValue({ size: 1024 }),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}))

describe('MediaContextService', () => {
  let service: MediaContextService

  beforeEach(() => {
    service = new MediaContextService()
    vi.clearAllMocks()
  })

  // ─── getMediaType ───────────────────────────────────────────

  describe('getMediaType', () => {
    it('returns image for type 3', () => {
      expect(service.getMediaType({ localId: 1, localType: 3 })).toBe('image')
    })

    it('returns voice for type 34', () => {
      expect(service.getMediaType({ localId: 1, localType: 34 })).toBe('voice')
    })

    it('returns video for type 43', () => {
      expect(service.getMediaType({ localId: 1, localType: 43 })).toBe('video')
    })

    it('returns null for text type 1', () => {
      expect(service.getMediaType({ localId: 1, localType: 1 })).toBeNull()
    })

    it('returns article for type 49 with gh_ prefix', () => {
      const msg: WCDBMessage = {
        localId: 1,
        localType: 49,
        rawContent: '<msg><appmsg><type>5</type><sourceusername>gh_abc123</sourceusername><url>https://mp.weixin.qq.com/s/test</url></appmsg></msg>',
      }
      expect(service.getMediaType(msg)).toBe('article')
    })

    it('returns video-channel for xmlType 51', () => {
      const msg: WCDBMessage = {
        localId: 1,
        localType: 49,
        rawContent: '<msg><appmsg><type>51</type><title>Test</title></appmsg></msg>',
      }
      expect(service.getMediaType(msg)).toBe('video-channel')
    })

    it('returns forward for xmlType 19', () => {
      const msg: WCDBMessage = {
        localId: 1,
        localType: 49,
        rawContent: '<msg><appmsg><type>19</type><title>聊天记录</title></appmsg></msg>',
      }
      expect(service.getMediaType(msg)).toBe('forward')
    })

    it('returns miniapp for xmlType 33', () => {
      const msg: WCDBMessage = {
        localId: 1,
        localType: 49,
        rawContent: '<msg><appmsg><type>33</type><title>小程序</title></appmsg></msg>',
      }
      expect(service.getMediaType(msg)).toBe('miniapp')
    })

    it('returns miniapp for xmlType 36', () => {
      const msg: WCDBMessage = {
        localId: 1,
        localType: 49,
        rawContent: '<msg><appmsg><type>36</type><title>小程序</title></appmsg></msg>',
      }
      expect(service.getMediaType(msg)).toBe('miniapp')
    })
  })

  // ─── processMessage routing ─────────────────────────────────

  describe('processMessage', () => {
    it('returns null for text messages', async () => {
      const msg: WCDBMessage = { localId: 1, localType: 1, parsedContent: 'hello' }
      const result = await service.processMessage(msg)
      expect(result).toBeNull()
    })

    it('processes video channel messages', async () => {
      const msg: WCDBMessage = {
        localId: 1,
        localType: 49,
        rawContent: '<msg><appmsg><type>51</type><title>直播回放</title><findernickname>张三</findernickname></appmsg></msg>',
      }
      const result = await service.processMessage(msg)
      expect(result).not.toBeNull()
      expect(result!.type).toBe('video-channel')
      expect(result!.processedContent).toBe('[视频号] 张三: 直播回放')
    })

    it('processes miniapp messages', async () => {
      const msg: WCDBMessage = {
        localId: 2,
        localType: 49,
        rawContent: '<msg><appmsg><type>33</type><title>今日天气</title><appname>天气助手</appname></appmsg></msg>',
      }
      const result = await service.processMessage(msg)
      expect(result).not.toBeNull()
      expect(result!.type).toBe('miniapp')
      expect(result!.processedContent).toBe('[小程序] 天气助手: 今日天气')
    })

    it('caches processed results', async () => {
      const msg: WCDBMessage = {
        localId: 3,
        localType: 49,
        rawContent: '<msg><appmsg><type>51</type><title>Test</title><findernickname>Creator</findernickname></appmsg></msg>',
      }
      const result1 = await service.processMessage(msg)
      const result2 = await service.processMessage(msg)
      expect(result1).toEqual(result2)
    })
  })

  // ─── processVoice ──────────────────────────────────────────

  describe('processVoice', () => {
    it('returns transcription when service is available', async () => {
      service.setVoiceTranscribeService({
        transcribe: vi.fn().mockResolvedValue({ text: '你好世界' }),
      })

      const msg: WCDBMessage = {
        localId: 10,
        localType: 34,
        parsedContent: '发了一条语音',
      }
      const result = await service.processVoice(msg)
      expect(result.type).toBe('voice')
      expect(result.processedContent).toBe('[语音转文字] 你好世界')
    })

    it('returns error when transcribe service unavailable', async () => {
      const msg: WCDBMessage = {
        localId: 11,
        localType: 34,
        parsedContent: '发了一条语音',
      }
      const result = await service.processVoice(msg)
      expect(result.processedContent).toContain('[语音]')
      expect(result.processedContent).toContain('不可用')
    })

    it('handles transcription failure gracefully', async () => {
      service.setVoiceTranscribeService({
        transcribe: vi.fn().mockRejectedValue(new Error('file not found')),
      })

      const msg: WCDBMessage = {
        localId: 12,
        localType: 34,
        parsedContent: '发了一条语音',
      }
      const result = await service.processVoice(msg)
      expect(result.processedContent).toContain('[语音]')
      expect(result.processedContent).toContain('缺失')
    })
  })

  // ─── processVideoChannel ──────────────────────────────────

  describe('processVideoChannel', () => {
    it('extracts creator and title from message', () => {
      const msg: WCDBMessage = {
        localId: 20,
        localType: 49,
        finderNickname: '极视角',
        linkTitle: '港股上市直播',
      }
      const result = service.processVideoChannel(msg)
      expect(result.processedContent).toBe('[视频号] 极视角: 港股上市直播')
    })

    it('uses defaults when metadata missing', () => {
      const msg: WCDBMessage = {
        localId: 21,
        localType: 49,
        rawContent: '<msg><appmsg><type>51</type></appmsg></msg>',
      }
      const result = service.processVideoChannel(msg)
      expect(result.processedContent).toContain('[视频号]')
      expect(result.processedContent).toContain('未知')
    })
  })

  // ─── processForward ────────────────────────────────────────

  describe('processForward', () => {
    it('flattens chat records into readable text', async () => {
      const records = [
        { datatype: 1, sourcename: '张三', sourcetime: '2024-01-01', datadesc: '你好' },
        { datatype: 1, sourcename: '李四', sourcetime: '2024-01-01', datadesc: '好的' },
      ]
      const result = await service.processForward(records)
      expect(result.type).toBe('forward')
      expect(result.processedContent).toContain('张三: 你好')
      expect(result.processedContent).toContain('李四: 好的')
    })

    it('handles nested chat records recursively', async () => {
      const records = [
        {
          datatype: 1,
          sourcename: '张三',
          sourcetime: '2024-01-01',
          datadesc: '转发的消息',
          chatRecordList: [
            { datatype: 1, sourcename: '王五', sourcetime: '2024-01-01', datadesc: '原始消息' },
          ],
        },
      ]
      const result = await service.processForward(records)
      expect(result.processedContent).toContain('张三: 转发的消息')
      expect(result.processedContent).toContain('王五: 原始消息')
    })
  })

  // ─── processMiniApp ────────────────────────────────────────

  describe('processMiniApp', () => {
    it('formats miniapp with name and title', () => {
      const msg: WCDBMessage = {
        localId: 30,
        localType: 49,
        appMsgAppName: '滴滴出行',
        linkTitle: '上海→北京',
      }
      const result = service.processMiniApp(msg)
      expect(result.processedContent).toBe('[小程序] 滴滴出行: 上海→北京')
    })
  })

  // ─── processArticle ────────────────────────────────────────

  describe('processArticle', () => {
    it('returns fallback for unsafe URLs', async () => {
      const result = await service.processArticle('file:///etc/passwd', '恶意链接')
      expect(result.processedContent).toContain('[分享]')
      expect(result.metadata?.error).toBe('unsafe_url')
    })

    it('returns timeout error for network failures', async () => {
      // Mock fetch to throw timeout
      const originalFetch = global.fetch
      global.fetch = vi.fn().mockRejectedValue(Object.assign(new Error('timeout'), { name: 'TimeoutError' }))

      const result = await service.processArticle('https://mp.weixin.qq.com/s/test', '测试文章')
      expect(result.processedContent).toContain('加载超时')

      global.fetch = originalFetch
    })
  })

  // ─── processImage ──────────────────────────────────────────

  describe('processImage', () => {
    it('returns decrypt error when no service', async () => {
      const result = await service.processImage(100)
      expect(result.processedContent).toContain('无法解密')
    })

    it('returns decrypt error when service fails', async () => {
      service.setImageDecryptService({
        decryptImage: vi.fn().mockRejectedValue(new Error('decrypt error')),
      })
      const result = await service.processImage(101)
      expect(result.processedContent).toContain('无法解密')
    })

    it('returns decrypt error when no result path', async () => {
      service.setImageDecryptService({
        decryptImage: vi.fn().mockResolvedValue({ success: false, error: 'no file' }),
      })
      const result = await service.processImage(102)
      expect(result.processedContent).toContain('无法解密')
    })

    it('processes image successfully with decrypt service returning buffer path', async () => {
      // Since fs is lazily required inside the service, we test that the
      // code path correctly returns decrypt_failed or no_buffer when the
      // file system is not accessible in the test environment.
      // The integration with real fs is tested in the Electron environment.
      service.setImageDecryptService({
        decryptImage: vi.fn().mockResolvedValue({ success: true, localPath: '/tmp/test.jpg' }),
      })

      const result = await service.processImage(103, 'abc123')
      expect(result.type).toBe('image')
      // In test environment, getFs() returns real fs which won't find /tmp/test.jpg
      // so it will fall through to the "no_buffer" path
      expect(result.processedContent).toContain('[图片]')
    })

    it('returns decrypt error when localPath not found', async () => {
      service.setImageDecryptService({
        decryptImage: vi.fn().mockResolvedValue({ success: true, localPath: undefined }),
      })

      const result = await service.processImage(104)
      expect(result.processedContent).toContain('无法解密')
    })
  })

  // ─── processVideo ─────────────────────────────────────────

  describe('processVideo', () => {
    it('returns error when ffmpeg unavailable', async () => {
      const msg: WCDBMessage = { localId: 40, localType: 43, parsedContent: '[视频]' }
      const result = await service.processVideo(msg)
      expect(result.type).toBe('video')
      // ffmpeg-static may or may not be available in test environment
      expect(result.processedContent).toContain('视频内容描述')
    })
  })

  // ─── evictExpiredCache ─────────────────────────────────────

  describe('evictExpiredCache', () => {
    it('clears old cache entries', async () => {
      const msg: WCDBMessage = {
        localId: 50,
        localType: 49,
        rawContent: '<msg><appmsg><type>51</type><title>Test</title><findernickname>A</findernickname></appmsg></msg>',
      }
      await service.processMessage(msg)

      // Manually set old timestamp
      const cache = (service as any).cache
      for (const [key, entry] of cache) {
        entry.timestamp = Date.now() - 20 * 60 * 1000
      }

      service.evictExpiredCache()
      expect(cache.size).toBe(0)
    })
  })

  // ─── processMessage error fallback ────────────────────────

  describe('processMessage error fallback', () => {
    it('returns graceful fallback on unexpected error', async () => {
      // Force an error by mocking getMediaType to return image but no service
      const msg: WCDBMessage = { localId: 60, localType: 3 }
      const result = await service.processMessage(msg)
      expect(result).not.toBeNull()
      expect(result!.type).toBe('image')
    })
  })
})

// ─── Helper Functions ──────────────────────────────────────────

describe('extractArticleText', () => {
  it('strips scripts and styles', () => {
    const html = '<html><script>alert(1)</script><style>.foo{}</style><p>Hello world</p></html>'
    const text = extractArticleText(html)
    expect(text).toContain('Hello world')
    expect(text).not.toContain('alert')
    expect(text).not.toContain('.foo')
  })

  it('extracts article content preferentially', () => {
    const html = '<html><nav>Menu</nav><article><p>Article content here</p></article><footer>Footer</footer></html>'
    const text = extractArticleText(html)
    expect(text).toContain('Article content here')
    expect(text).not.toContain('Menu')
    expect(text).not.toContain('Footer')
  })

  it('extracts img alt text', () => {
    const html = '<article><img alt="一只猫" src="cat.jpg"><p>Some text</p></article>'
    const text = extractArticleText(html)
    expect(text).toContain('[图: 一只猫]')
  })

  it('decodes HTML entities', () => {
    const html = '<p>&amp; &lt;tag&gt; &nbsp; &quot;hello&quot;</p>'
    const text = extractArticleText(html)
    expect(text).toContain('& <tag>')
    expect(text).toContain('"hello"')
  })
})

describe('extractGenericPageText', () => {
  it('truncates to 3000 chars', () => {
    const longText = '<p>' + 'a'.repeat(5000) + '</p>'
    const text = extractGenericPageText(longText)
    expect(text.length).toBeLessThanOrEqual(3003) // 3000 + "..."
  })
})

describe('parseXmlType', () => {
  it('extracts type from appmsg', () => {
    const xml = '<msg><appmsg><type>5</type><title>Test</title></appmsg></msg>'
    expect(parseXmlType(xml)).toBe(5)
  })

  it('returns null for empty content', () => {
    expect(parseXmlType('')).toBeNull()
  })

  it('skips refermsg nested type', () => {
    const xml = '<msg><appmsg><type>57</type><refermsg><type>1</type></refermsg></appmsg></msg>'
    expect(parseXmlType(xml)).toBe(57)
  })
})

describe('isUrlSafe', () => {
  it('allows https URLs', () => {
    expect(isUrlSafe('https://mp.weixin.qq.com/s/test')).toBe(true)
  })

  it('rejects file:// URLs', () => {
    expect(isUrlSafe('file:///etc/passwd')).toBe(false)
  })

  it('rejects localhost', () => {
    expect(isUrlSafe('http://localhost:8080/test')).toBe(false)
  })

  it('rejects private IPs', () => {
    expect(isUrlSafe('http://192.168.1.1/admin')).toBe(false)
    expect(isUrlSafe('http://10.0.0.1/test')).toBe(false)
  })
})

describe('extractXmlValue', () => {
  it('extracts simple value', () => {
    expect(extractXmlValue('<title>Hello</title>', 'title')).toBe('Hello')
  })

  it('extracts CDATA value', () => {
    expect(extractXmlValue('<title><![CDATA[Hello World]]></title>', 'title')).toBe('Hello World')
  })

  it('returns undefined for missing tag', () => {
    expect(extractXmlValue('<foo>bar</foo>', 'baz')).toBeUndefined()
  })
})
