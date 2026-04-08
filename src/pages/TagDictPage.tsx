import { useState, useEffect, useCallback } from 'react'
import { Tag as TagIcon, RefreshCw } from 'lucide-react'
import {
  Table, Button, Modal, Form, Input, InputNumber, Alert, Space, message, Popconfirm, Tag,
} from 'antd'
import {
  PlusOutlined, EditOutlined, DeleteOutlined,
} from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import './TagDictPage.scss'

const API_BASE = 'https://store.quikms.com'

interface TagItem {
  id: number
  label: string
  sort: number
  type?: number
  type_name?: string
}

function TagDictPage() {
  const [tags, setTags] = useState<TagItem[]>([])
  const [childrenMap, setChildrenMap] = useState<Record<number, TagItem[]>>({})
  const [expandedKeys, setExpandedKeys] = useState<number[]>([])
  const [loading, setLoading] = useState(true)
  const [childLoading, setChildLoading] = useState<number | null>(null)
  const [error, setError] = useState('')

  // 一级弹窗
  const [showDialog1, setShowDialog1] = useState(false)
  const [editRecord1, setEditRecord1] = useState<TagItem | null>(null)
  const [submitting1, setSubmitting1] = useState(false)
  const [form1] = Form.useForm()

  // 二级弹窗
  const [showDialog2, setShowDialog2] = useState(false)
  const [editRecord2, setEditRecord2] = useState<TagItem | null>(null)
  const [parentForChild, setParentForChild] = useState<TagItem | null>(null)
  const [submitting2, setSubmitting2] = useState(false)
  const [form2] = Form.useForm()

  const fetchTags = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`${API_BASE}/admin/tag/list`)
      const json = await res.json()
      if (json.errno === 0) {
        setTags(json.data || [])
      } else {
        setError(json.errmsg || '请求失败')
      }
    } catch (e: any) {
      setError(e.message || '网络请求失败')
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchChildren = useCallback(async (parentId: number) => {
    setChildLoading(parentId)
    try {
      const res = await fetch(`${API_BASE}/admin/tag/item?parent_id=${parentId}`)
      const json = await res.json()
      if (json.errno === 0) {
        setChildrenMap((prev) => ({
          ...prev,
          [parentId]: json.data || [],
        }))
      }
    } catch {
      message.error('加载子标签失败')
    } finally {
      setChildLoading(null)
    }
  }, [])

  useEffect(() => {
    fetchTags()
  }, [fetchTags])

  const handleExpand = (expanded: boolean, record: TagItem) => {
    if (expanded && !childrenMap[record.id]) {
      fetchChildren(record.id)
    }
    setExpandedKeys((prev) =>
      expanded ? [...prev, record.id] : prev.filter((k) => k !== record.id)
    )
  }

  // ---- 一级新增/编辑 ----

  const openAdd1 = () => {
    setEditRecord1(null)
    form1.resetFields()
    setShowDialog1(true)
  }

  const openEdit1 = (record: TagItem) => {
    setEditRecord1(record)
    form1.setFieldsValue({
      label: record.label,
      sort: record.sort,
    })
    setShowDialog1(true)
  }

  const handleSubmit1 = async () => {
    try {
      const values = await form1.validateFields()
      setSubmitting1(true)
      const body: any = {
        label: values.label?.trim(),
        sort: values.sort ?? 0,
        type: 20,
      }
      if (editRecord1) body.id = editRecord1.id

      const res = await fetch(`${API_BASE}/admin/tag/put`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (json.errno === 0) {
        message.success(editRecord1 ? '编辑成功' : '新增成功')
        setShowDialog1(false)
        fetchTags()
      } else {
        message.error(json.errmsg || '操作失败')
      }
    } catch {
      // validateFields 失败
    } finally {
      setSubmitting1(false)
    }
  }

  // ---- 二级新增/编辑 ----

  const openAdd2 = (parent: TagItem) => {
    setParentForChild(parent)
    setEditRecord2(null)
    form2.resetFields()
    setShowDialog2(true)
  }

  const openEdit2 = (record: TagItem, parent: TagItem) => {
    setParentForChild(parent)
    setEditRecord2(record)
    form2.setFieldsValue({
      label: record.label,
      sort: record.sort,
    })
    setShowDialog2(true)
  }

  const handleSubmit2 = async () => {
    try {
      const values = await form2.validateFields()
      setSubmitting2(true)
      const body: any = {
        parent_id: parentForChild!.id,
        label: values.label?.trim(),
        sort: values.sort ?? 0,
        type: 20,
      }
      if (editRecord2) body.id = editRecord2.id

      const res = await fetch(`${API_BASE}/admin/tag/put`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (json.errno === 0) {
        message.success(editRecord2 ? '编辑成功' : '新增成功')
        setShowDialog2(false)
        fetchChildren(parentForChild!.id)
      } else {
        message.error(json.errmsg || '操作失败')
      }
    } catch {
      // validateFields 失败
    } finally {
      setSubmitting2(false)
    }
  }

  // ---- 删除 ----

  const handleDelete1 = async (id: number) => {
    try {
      const res = await fetch(`${API_BASE}/admin/tag/delete?id=${id}`)
      const json = await res.json()
      if (json.errno === 0) {
        message.success('删除成功')
        fetchTags()
        setChildrenMap((prev) => {
          const next = { ...prev }
          delete next[id]
          return next
        })
        setExpandedKeys((prev) => prev.filter((k) => k !== id))
      } else {
        message.error(json.errmsg || '删除失败')
      }
    } catch {
      message.error('删除请求失败')
    }
  }

  const handleDelete2 = async (id: number, parentId: number) => {
    try {
      const res = await fetch(`${API_BASE}/admin/tag/delete?id=${id}`)
      const json = await res.json()
      if (json.errno === 0) {
        message.success('删除成功')
        fetchChildren(parentId)
      } else {
        message.error(json.errmsg || '删除失败')
      }
    } catch {
      message.error('删除请求失败')
    }
  }

  // ---- 表格列 ----

  const columns1: ColumnsType<TagItem> = [
    {
      title: 'ID',
      dataIndex: 'id',
      key: 'id',
      width: 70,
      align: 'center',
    },
    {
      title: '标签名称',
      dataIndex: 'label',
      key: 'label',
      width: 200,
    },
    {
      title: '类型',
      dataIndex: 'type_name',
      key: 'type_name',
      width: 120,
      render: (v: string | undefined) => v ? <Tag color="blue">{v}</Tag> : '-',
    },
    {
      title: '排序',
      dataIndex: 'sort',
      key: 'sort',
      width: 80,
      align: 'center',
    },
    {
      title: '操作',
      key: 'action',
      width: 220,
      align: 'center',
      render: (_: unknown, record: TagItem) => (
        <Space size="small">
          <Button type="link" size="small" icon={<PlusOutlined />} onClick={() => openAdd2(record)}>
            新增子标签
          </Button>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEdit1(record)}>
            编辑
          </Button>
          <Popconfirm title="确认删除？删除后子标签也会被清除" onConfirm={() => handleDelete1(record.id)} okText="确认" cancelText="取消">
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  const columns2: ColumnsType<TagItem> = [
    {
      title: 'ID',
      dataIndex: 'id',
      key: 'id',
      width: 70,
      align: 'center',
    },
    {
      title: '子标签名称',
      dataIndex: 'label',
      key: 'label',
      width: 200,
    },
    {
      title: '排序',
      dataIndex: 'sort',
      key: 'sort',
      width: 80,
      align: 'center',
    },
    {
      title: '操作',
      key: 'action',
      width: 160,
      align: 'center',
      render: (_: unknown, record: TagItem) => {
        const parent = tags.find((t) => expandedKeys.includes(t.id) && childrenMap[t.id]?.some((c) => c.id === record.id))
        return (
          <Space size="small">
            <Button type="link" size="small" icon={<EditOutlined />} onClick={() => parent && openEdit2(record, parent)}>
              编辑
            </Button>
            <Popconfirm title="确认删除？" onConfirm={() => parent && handleDelete2(record.id, parent.id)} okText="确认" cancelText="取消">
              <Button type="link" size="small" danger icon={<DeleteOutlined />}>
                删除
              </Button>
            </Popconfirm>
          </Space>
        )
      },
    },
  ]

  return (
    <div className="tag-dict-page">
      <div className="tag-page-header">
        <div className="tag-page-title">
          <TagIcon size={24} />
          <h2>标签字典</h2>
        </div>
        <Space>
          <span className="tag-count">共 {tags.length} 个一级标签</span>
          <Button type="primary" icon={<PlusOutlined />} onClick={openAdd1}>
            新增标签
          </Button>
          <Button
            icon={<RefreshCw size={14} className={loading ? 'spinning' : ''} />}
            onClick={() => fetchTags()}
            disabled={loading}
          >
            刷新
          </Button>
        </Space>
      </div>

      {error && (
        <Alert type="error" message={error} closable onClose={() => setError('')} style={{ marginBottom: 16 }} />
      )}

      <Table<TagItem>
        columns={columns1}
        dataSource={tags}
        rowKey="id"
        loading={loading}
        pagination={false}
        expandable={{
          expandedRowKeys: expandedKeys,
          onExpand: handleExpand,
          expandedRowRender: (parent) => {
            const children = childrenMap[parent.id] || []
            if (childLoading === parent.id) {
              return <div style={{ textAlign: 'center', padding: 16, color: '#999' }}>加载中...</div>
            }
            if (children.length === 0) {
              return <div style={{ textAlign: 'center', padding: 16, color: '#999' }}>暂无子标签</div>
            }
            return (
              <Table<TagItem>
                columns={columns2}
                dataSource={children}
                rowKey="id"
                pagination={false}
                size="small"
              />
            )
          },
        }}
        size="middle"
      />

      {/* 一级标签弹窗 */}
      <Modal
        title={editRecord1 ? '编辑标签' : '新增标签'}
        open={showDialog1}
        onCancel={() => setShowDialog1(false)}
        onOk={handleSubmit1}
        okText={editRecord1 ? '保存' : '确认新增'}
        cancelText="取消"
        confirmLoading={submitting1}
        destroyOnClose
        width={480}
      >
        <Form form={form1} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item label="标签名称" name="label" rules={[{ required: true, message: '请输入标签名称' }]}>
            <Input placeholder="请输入标签名称" />
          </Form.Item>
          <Form.Item label="排序" name="sort" initialValue={0}>
            <InputNumber min={0} style={{ width: '100%' }} placeholder="排序值" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 二级标签弹窗 */}
      <Modal
        title={editRecord2 ? `编辑子标签（${parentForChild?.label}）` : `新增子标签（${parentForChild?.label}）`}
        open={showDialog2}
        onCancel={() => setShowDialog2(false)}
        onOk={handleSubmit2}
        okText={editRecord2 ? '保存' : '确认新增'}
        cancelText="取消"
        confirmLoading={submitting2}
        destroyOnClose
        width={480}
      >
        <Form form={form2} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item label="子标签名称" name="label" rules={[{ required: true, message: '请输入子标签名称' }]}>
            <Input placeholder="请输入子标签名称" />
          </Form.Item>
          <Form.Item label="排序" name="sort" initialValue={0}>
            <InputNumber min={0} style={{ width: '100%' }} placeholder="排序值" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

export default TagDictPage
