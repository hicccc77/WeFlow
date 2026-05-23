import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, KeyRound, Link2, MessageSquareText, SlidersHorizontal } from 'lucide-react'
import { AI_ANALYSIS_LOG_RETENTION_DAYS } from '../features/ai-analysis/defaults'
import { getAiAnalysisSettings, setAiAnalysisSettings } from '../features/ai-analysis/storage'
import type { AiAnalysisMediaType } from '../features/ai-analysis/types'
import './GroupAiPages.scss'

function GroupAiSettingsPage() {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')
  const [form, setForm] = useState({
    apiKey: '',
    baseUrl: '',
    model: '',
    preprocessPrompt: '',
    mergePrompt: '',
    defaultDays: 30,
    mediaText: true,
    mediaImage: false,
    mediaVideo: false
  })

  useEffect(() => {
    const load = async () => {
      try {
        const settings = await getAiAnalysisSettings()
        const mediaSet = new Set(settings.defaultMediaTypes)
        setForm({
          apiKey: settings.apiKey,
          baseUrl: settings.baseUrl,
          model: settings.model,
          preprocessPrompt: settings.preprocessPrompt,
          mergePrompt: settings.mergePrompt,
          defaultDays: settings.defaultDays,
          mediaText: mediaSet.has('text'),
          mediaImage: mediaSet.has('image'),
          mediaVideo: mediaSet.has('video')
        })
      } finally {
        setLoading(false)
      }
    }
    void load()
  }, [])

  const save = async () => {
    if (saving) return
    setSaving(true)
    setNotice('')
    try {
      const mediaTypes: AiAnalysisMediaType[] = []
      if (form.mediaText) mediaTypes.push('text')
      if (form.mediaImage) mediaTypes.push('image')
      if (form.mediaVideo) mediaTypes.push('video')
      await setAiAnalysisSettings({
        apiKey: form.apiKey.trim(),
        baseUrl: form.baseUrl.trim(),
        model: form.model.trim(),
        preprocessPrompt: form.preprocessPrompt.trim(),
        mergePrompt: form.mergePrompt.trim(),
        defaultDays: Number(form.defaultDays || 30),
        defaultMediaTypes: mediaTypes.length > 0 ? mediaTypes : ['text']
      })
      setNotice('设置已保存')
    } catch (error) {
      setNotice(`保存失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="group-ai-page">
      <div className="group-ai-page__header">
        <button className="group-ai-page__back" onClick={() => navigate('/analytics/group')}>
          <ArrowLeft size={18} />
          <span>返回群聊分析</span>
        </button>
        <h2>AI设置</h2>
        <p>DeepSeek 接入、提示词与运行策略配置（独立命名空间存储）。</p>
      </div>

      {loading ? (
        <section className="group-ai-card"><p>加载中...</p></section>
      ) : (
        <div className="group-ai-form">
          <section className="group-ai-card">
            <h3><KeyRound size={16} /> 接入配置</h3>
            <label>API Key</label>
            <input value={form.apiKey} onChange={(e) => setForm(prev => ({ ...prev, apiKey: e.target.value }))} placeholder="sk-..." />
            <label>Base URL</label>
            <input value={form.baseUrl} onChange={(e) => setForm(prev => ({ ...prev, baseUrl: e.target.value }))} placeholder="https://api.deepseek.com/v1" />
            <label>模型名称</label>
            <input value={form.model} onChange={(e) => setForm(prev => ({ ...prev, model: e.target.value }))} placeholder="deepseek-chat" />
          </section>

          <section className="group-ai-card">
            <h3><MessageSquareText size={16} /> 提示词管理</h3>
            <label>预处理提示词</label>
            <textarea rows={4} value={form.preprocessPrompt} onChange={(e) => setForm(prev => ({ ...prev, preprocessPrompt: e.target.value }))} />
            <label>合并/最终分析提示词</label>
            <textarea rows={4} value={form.mergePrompt} onChange={(e) => setForm(prev => ({ ...prev, mergePrompt: e.target.value }))} />
          </section>

          <section className="group-ai-card">
            <h3><SlidersHorizontal size={16} /> 运行策略</h3>
            <label>默认时间范围（天）</label>
            <input type="number" min={1} max={365} value={form.defaultDays} onChange={(e) => setForm(prev => ({ ...prev, defaultDays: Number(e.target.value || 30) }))} />
            <label>默认内容类型</label>
            <div className="group-ai-checkboxes">
              <label><input type="checkbox" checked={form.mediaText} onChange={(e) => setForm(prev => ({ ...prev, mediaText: e.target.checked }))} />文本</label>
              <label><input type="checkbox" checked={form.mediaImage} onChange={(e) => setForm(prev => ({ ...prev, mediaImage: e.target.checked }))} />图片</label>
              <label><input type="checkbox" checked={form.mediaVideo} onChange={(e) => setForm(prev => ({ ...prev, mediaVideo: e.target.checked }))} />视频</label>
            </div>
          </section>

          <section className="group-ai-card">
            <h3><Link2 size={16} /> 日志策略</h3>
            <p>所有用户可见；日志保留 {AI_ANALYSIS_LOG_RETENTION_DAYS} 天；记录完整提示词、请求参数、响应与状态。</p>
            <div className="group-ai-actions">
              <button onClick={() => void save()} disabled={saving}>{saving ? '保存中...' : '保存设置'}</button>
              {notice ? <span>{notice}</span> : null}
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

export default GroupAiSettingsPage
