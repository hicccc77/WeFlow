import { useState, useEffect, useCallback, useRef } from 'react'
import ReactECharts from 'echarts-for-react'
import { useThemeStore } from '../stores/themeStore'
import { X, Users, MessageSquare, Calendar, Loader2, RefreshCw } from 'lucide-react'
import './GraphPage.scss'

interface GraphNode {
  id: string
  name: string
  category: number
  symbolSize: number
  value: number
  groups: string[]
}

interface GraphEdge {
  source: string
  target: string
  value: number
}

interface NodeDetail {
  id: string
  name: string
  relationship: string
  frequency: number
  lastContact: string
  sharedGroups: string[]
  topics: string[]
}

const CATEGORIES = [
  { name: '自己' },
  { name: '密切联系人' },
  { name: '一般联系人' },
  { name: '低频联系人' },
]

function GraphPage() {
  const themeMode = useThemeStore(state => state.themeMode)
  const [nodes, setNodes] = useState<GraphNode[]>([])
  const [edges, setEdges] = useState<GraphEdge[]>([])
  const [selectedNode, setSelectedNode] = useState<NodeDetail | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isBuilding, setIsBuilding] = useState(false)
  const chartRef = useRef<ReactECharts | null>(null)

  const isDark = themeMode === 'dark' || (themeMode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  const loadGraph = useCallback(async () => {
    setIsLoading(true)
    try {
      const [nodesResult, edgesResult] = await Promise.all([
        window.electronAPI.graph.getNodes(),
        window.electronAPI.graph.getEdges(),
      ])

      if (nodesResult && Array.isArray(nodesResult)) {
        setNodes(nodesResult.map((n: any) => ({
          id: n.id || n.name,
          name: n.name || n.id,
          category: n.category ?? 2,
          symbolSize: Math.max(20, Math.min(50, (n.value || 30) * 0.5)),
          value: n.value || 30,
          groups: n.groups || [],
        })))
      }

      if (edgesResult && Array.isArray(edgesResult)) {
        setEdges(edgesResult.map((e: any) => ({
          source: e.source,
          target: e.target,
          value: e.value || 1,
        })))
      }
    } catch (e) {
      console.error('Failed to load graph data:', e)
    } finally {
      setIsLoading(false)
    }
  }, [])

  const buildGraph = useCallback(async () => {
    setIsBuilding(true)
    try {
      await window.electronAPI.graph.build()
      await loadGraph()
    } catch (e) {
      console.error('Failed to build graph:', e)
    } finally {
      setIsBuilding(false)
    }
  }, [loadGraph])

  useEffect(() => {
    loadGraph()
  }, [loadGraph])

  const getOption = useCallback(() => ({
    tooltip: {
      trigger: 'item' as const,
      formatter: (params: { data: { name?: string; value?: number }; dataType: string }) => {
        if (params.dataType === 'node') {
          return `<strong>${params.data.name}</strong><br/>沟通频率: ${params.data.value}`
        }
        return ''
      },
    },
    legend: {
      data: CATEGORIES.map(c => c.name),
      bottom: 10,
      textStyle: { color: isDark ? '#94a3b8' : '#64748b', fontSize: 12 },
    },
    animationDuration: 1500,
    animationEasingUpdate: 'quinticInOut' as const,
    series: [
      {
        type: 'graph' as const,
        layout: 'force' as const,
        data: nodes.map(node => ({
          ...node,
          label: {
            show: true,
            fontSize: node.category === 0 ? 14 : 12,
            color: isDark ? '#e2e8f0' : '#1e293b',
          },
          itemStyle: {
            borderWidth: 2,
            borderColor: isDark ? '#334155' : '#e2e8f0',
          },
        })),
        links: edges.map(edge => ({
          ...edge,
          lineStyle: {
            width: edge.value * 0.5,
            color: isDark ? 'rgba(148, 163, 184, 0.3)' : 'rgba(100, 116, 139, 0.2)',
            curveness: 0.1,
          },
        })),
        categories: CATEGORIES,
        roam: true,
        force: {
          repulsion: 200,
          gravity: 0.1,
          edgeLength: [80, 200],
          friction: 0.6,
        },
        emphasis: {
          focus: 'adjacency' as const,
          lineStyle: { width: 4 },
        },
        scaleLimit: { min: 0.5, max: 3 },
      },
    ],
  }), [isDark, nodes, edges])

  const handleChartClick = useCallback(async (params: { dataType: string; data: { id: string; name?: string } }) => {
    if (params.dataType === 'node' && params.data.id !== 'me') {
      try {
        const detail = await window.electronAPI.graph.getContactDetail(params.data.id)
        if (detail) {
          setSelectedNode({
            id: params.data.id,
            name: detail.name || params.data.name || params.data.id,
            relationship: detail.relationship_type || detail.relationship || '联系人',
            frequency: detail.frequency || detail.message_count || 0,
            lastContact: detail.lastContact || detail.last_updated || '未知',
            sharedGroups: detail.sharedGroups || detail.shared_groups || [],
            topics: detail.topics || [],
          })
        } else {
          const node = nodes.find(n => n.id === params.data.id)
          if (node) {
            setSelectedNode({
              id: node.id,
              name: node.name,
              relationship: '联系人',
              frequency: Math.round(node.value / 10),
              lastContact: '最近',
              sharedGroups: node.groups,
              topics: [],
            })
          }
        }
      } catch {
        const node = nodes.find(n => n.id === params.data.id)
        if (node) {
          setSelectedNode({
            id: node.id,
            name: node.name,
            relationship: '联系人',
            frequency: Math.round(node.value / 10),
            lastContact: '最近',
            sharedGroups: node.groups,
            topics: [],
          })
        }
      }
    }
  }, [nodes])

  if (isLoading) {
    return (
      <div className="graph-page">
        <div className="graph-loading">
          <Loader2 size={24} className="spinning" />
          <span>加载社交图谱...</span>
        </div>
      </div>
    )
  }

  if (nodes.length === 0) {
    return (
      <div className="graph-page">
        <div className="graph-empty">
          <Users size={48} />
          <h3>暂无图谱数据</h3>
          <p>从聊天记录分析联系人关系，构建社交关系图谱</p>
          <button
            className="btn btn-primary"
            onClick={buildGraph}
            disabled={isBuilding}
            style={{ marginTop: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}
          >
            {isBuilding ? <Loader2 size={16} className="spinning" /> : <RefreshCw size={16} />}
            {isBuilding ? '正在构建...' : '构建图谱'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="graph-page">
      <div className="graph-toolbar" style={{ position: 'absolute', top: '16px', right: '16px', zIndex: 10 }}>
        <button
          className="btn btn-secondary btn-sm"
          onClick={buildGraph}
          disabled={isBuilding}
          style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
        >
          {isBuilding ? <Loader2 size={14} className="spinning" /> : <RefreshCw size={14} />}
          {isBuilding ? '构建中...' : '刷新图谱'}
        </button>
      </div>
      <div className="graph-container">
        <ReactECharts
          ref={chartRef}
          option={getOption()}
          style={{ width: '100%', height: '100%' }}
          onEvents={{ click: handleChartClick }}
          notMerge
        />
      </div>

      {selectedNode && (
        <div className="graph-detail-panel">
          <div className="detail-header">
            <h3>{selectedNode.name}</h3>
            <button onClick={() => setSelectedNode(null)}><X size={16} /></button>
          </div>
          <div className="detail-body">
            <div className="detail-field">
              <Users size={14} />
              <label>关系</label>
              <span>{selectedNode.relationship}</span>
            </div>
            <div className="detail-field">
              <MessageSquare size={14} />
              <label>沟通频率</label>
              <span>{selectedNode.frequency} 条/周</span>
            </div>
            <div className="detail-field">
              <Calendar size={14} />
              <label>最近联系</label>
              <span>{selectedNode.lastContact}</span>
            </div>

            {selectedNode.sharedGroups.length > 0 && (
              <div className="detail-section">
                <h4>共同群聊</h4>
                <div className="detail-tags">
                  {selectedNode.sharedGroups.map((g, i) => (
                    <span key={i} className="detail-tag">{g}</span>
                  ))}
                </div>
              </div>
            )}

            {selectedNode.topics.length > 0 && (
              <div className="detail-section">
                <h4>近期话题</h4>
                <div className="detail-tags">
                  {selectedNode.topics.map((t, i) => (
                    <span key={i} className="detail-tag topic">{t}</span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default GraphPage
