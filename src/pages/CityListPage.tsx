import { useState, useEffect, useCallback } from 'react'
import { MapPin, RefreshCw } from 'lucide-react'
import {
  Table, Button, Modal, Form, Input, InputNumber, Alert, Space, message, Popconfirm,
} from 'antd'
import {
  PlusOutlined, EditOutlined, DeleteOutlined,
} from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import './CityListPage.scss'

const API_BASE = 'https://store.quikms.com'

// ---- 1级商圈 ----
interface CityItem {
  id: number
  parent_id: number
  label: string
  description: string | null
  sort: number
  create_time: string | null
}

// ---- 2级商圈（带 children） ----
interface CityCascaderItem extends CityItem {
  children: CityCascaderItem[]
}

interface CityListResponse {
  errno: number
  errmsg: string
  data: {
    count: number
    totalPages: number
    pageSize: number
    currentPage: number
    data: CityItem[]
  }
}

interface CascaderResponse {
  errno: number
  errmsg: string
  data: CityCascaderItem[]
}

function CityListPage() {
  const [cities, setCities] = useState<CityItem[]>([])
  const [childrenMap, setChildrenMap] = useState<Record<number, CityItem[]>>({})
  const [expandedKeys, setExpandedKeys] = useState<number[]>([])
  const [loading, setLoading] = useState(true)
  const [childLoading, setChildLoading] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [currentPage, setCurrentPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [pageSize, setPageSize] = useState(10)

  // 1级弹窗
  const [showDialog1, setShowDialog1] = useState(false)
  const [editRecord1, setEditRecord1] = useState<CityItem | null>(null)
  const [submitting1, setSubmitting1] = useState(false)
  const [form1] = Form.useForm()

  // 2级弹窗
  const [showDialog2, setShowDialog2] = useState(false)
  const [editRecord2, setEditRecord2] = useState<CityItem | null>(null)
  const [parentForChild, setParentForChild] = useState<CityItem | null>(null)
  const [submitting2, setSubmitting2] = useState(false)
  const [form2] = Form.useForm()

  // ---- 数据加载 ----

  const fetchCities = useCallback(async (page: number = 1, size?: number) => {
    const actualSize = size || pageSize
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`${API_BASE}/admin/city/list?page=${page}&size=${actualSize}`)
      const json: CityListResponse = await res.json()
      if (json.errno === 0) {
        setCities(json.data.data || [])
        setTotal(json.data.count)
        setCurrentPage(json.data.currentPage)
      } else {
        setError(json.errmsg || '请求失败')
      }
    } catch (e: any) {
      setError(e.message || '网络请求失败')
    } finally {
      setLoading(false)
    }
  }, [pageSize])

  const fetchChildren = useCallback(async (parentId: number) => {
    setChildLoading(parentId)
    try {
      const res = await fetch(`${API_BASE}/admin/city/cascader`)
      const json: CascaderResponse = await res.json()
      if (json.errno === 0) {
        const parent = json.data.find((item) => item.id === parentId)
        setChildrenMap((prev) => ({
          ...prev,
          [parentId]: parent?.children || [],
        }))
      }
    } catch {
      message.error('加载子商圈失败')
    } finally {
      setChildLoading(null)
    }
  }, [])

  useEffect(() => {
    fetchCities(1)
  }, [fetchCities])

  const handleExpand = (expanded: boolean, record: CityItem) => {
    if (expanded && !childrenMap[record.id]) {
      fetchChildren(record.id)
    }
    setExpandedKeys((prev) =>
      expanded ? [...prev, record.id] : prev.filter((k) => k !== record.id)
    )
  }

  // ---- 1级新增/编辑 ----

  const openAdd1 = () => {
    setEditRecord1(null)
    form1.resetFields()
    setShowDialog1(true)
  }

  const openEdit1 = (record: CityItem) => {
    setEditRecord1(record)
    form1.setFieldsValue({
      label: record.label,
      description: record.description || '',
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
        description: values.description?.trim() || null,
        sort: values.sort ?? 0,
      }
      if (editRecord1) body.id = editRecord1.id

      const res = await fetch(`${API_BASE}/admin/city/put`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (json.errno === 0) {
        message.success(editRecord1 ? '编辑成功' : '新增成功')
        setShowDialog1(false)
        fetchCities(currentPage)
      } else {
        message.error(json.errmsg || '操作失败')
      }
    } catch {
      // validateFields 失败
    } finally {
      setSubmitting1(false)
    }
  }

  // ---- 2级新增/编辑 ----

  const openAdd2 = (parent: CityItem) => {
    setParentForChild(parent)
    setEditRecord2(null)
    form2.resetFields()
    setShowDialog2(true)
  }

  const openEdit2 = (record: CityItem, parent: CityItem) => {
    setParentForChild(parent)
    setEditRecord2(record)
    form2.setFieldsValue({
      label: record.label,
      description: record.description || '',
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
        description: values.description?.trim() || null,
        sort: values.sort ?? 0,
      }
      if (editRecord2) body.id = editRecord2.id

      const res = await fetch(`${API_BASE}/admin/city/itemPut`, {
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

  const handleDelete = async (id: number) => {
    try {
      const res = await fetch(`${API_BASE}/admin/city/delete?id=${id}`)
      const json = await res.json()
      if (json.errno === 0) {
        message.success('删除成功')
        fetchCities(currentPage)
        // 清除缓存
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

  // ---- 表格列 ----

  const columns1: ColumnsType<CityItem> = [
    {
      title: 'ID',
      dataIndex: 'id',
      key: 'id',
      width: 70,
      align: 'center',
    },
    {
      title: '名称',
      dataIndex: 'label',
      key: 'label',
      width: 160,
    },
    {
      title: '描述',
      dataIndex: 'description',
      key: 'description',
      width: 120,
      render: (v: string | null) => v || '-',
    },
    {
      title: '排序',
      dataIndex: 'sort',
      key: 'sort',
      width: 80,
      align: 'center',
    },
    {
      title: '创建时间',
      dataIndex: 'create_time',
      key: 'create_time',
      width: 170,
      render: (v: string | null) => v || '-',
    },
    {
      title: '操作',
      key: 'action',
      width: 200,
      align: 'center',
      render: (_: unknown, record: CityItem) => (
        <Space size="small">
          <Button type="link" size="small" icon={<PlusOutlined />} onClick={() => openAdd2(record)}>
            新增子项
          </Button>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEdit1(record)}>
            编辑
          </Button>
          <Popconfirm title="确认删除？" onConfirm={() => handleDelete(record.id)} okText="确认" cancelText="取消">
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  const columns2: ColumnsType<CityItem> = [
    {
      title: 'ID',
      dataIndex: 'id',
      key: 'id',
      width: 70,
      align: 'center',
    },
    {
      title: '商圈名称',
      dataIndex: 'label',
      key: 'label',
      width: 160,
    },
    {
      title: '描述',
      dataIndex: 'description',
      key: 'description',
      width: 120,
      render: (v: string | null) => v || '-',
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
      render: (_: unknown, record: CityItem, index: number) => {
        // 从 expandedRows 获取 parent
        const parentId = record.parent_id
        const parent = cities.find((c) => c.id === parentId)
        return (
          <Space size="small">
            <Button type="link" size="small" icon={<EditOutlined />} onClick={() => parent && openEdit2(record, parent)}>
              编辑
            </Button>
            <Popconfirm title="确认删除？" onConfirm={() => handleDelete(record.id)} okText="确认" cancelText="取消">
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
    <div className="city-list-page">
      <div className="city-page-header">
        <div className="city-page-title">
          <MapPin size={24} />
          <h2>商圈列表</h2>
        </div>
        <Space>
          <span className="city-count">共 {total} 个商圈区域</span>
          <Button type="primary" icon={<PlusOutlined />} onClick={openAdd1}>
            新增区域
          </Button>
          <Button
            icon={<RefreshCw size={14} className={loading ? 'spinning' : ''} />}
            onClick={() => fetchCities(currentPage)}
            disabled={loading}
          >
            刷新
          </Button>
        </Space>
      </div>

      {error && (
        <Alert type="error" message={error} closable onClose={() => setError('')} style={{ marginBottom: 16 }} />
      )}

      <Table<CityItem>
        columns={columns1}
        dataSource={cities}
        rowKey="id"
        loading={loading}
        expandable={{
          expandedRowKeys: expandedKeys,
          onExpand: handleExpand,
          expandedRowRender: (parent) => {
            const children = childrenMap[parent.id] || []
            if (childLoading === parent.id) {
              return <div style={{ textAlign: 'center', padding: 16, color: '#999' }}>加载中...</div>
            }
            return (
              <Table<CityItem>
                columns={columns2}
                dataSource={children}
                rowKey="id"
                pagination={false}
                size="small"
              />
            )
          },
        }}
        pagination={{
          current: currentPage,
          total,
          pageSize,
          showTotal: (t) => `共 ${t} 条`,
          onChange: (page, newPageSize) => {
            if (newPageSize !== pageSize) {
              setPageSize(newPageSize)
              fetchCities(1, newPageSize)
            } else {
              fetchCities(page)
            }
          },
          showSizeChanger: true,
          showQuickJumper: true,
          pageSizeOptions: ['10', '20', '50'],
        }}
        size="middle"
      />

      {/* 1级弹窗 */}
      <Modal
        title={editRecord1 ? '编辑区域' : '新增区域'}
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
          <Form.Item label="区域名称" name="label" rules={[{ required: true, message: '请输入区域名称' }]}>
            <Input placeholder="如：朝阳区" />
          </Form.Item>
          <Form.Item label="描述" name="description">
            <Input placeholder="描述（选填）" />
          </Form.Item>
          <Form.Item label="排序" name="sort" initialValue={0}>
            <InputNumber min={0} style={{ width: '100%' }} placeholder="排序值" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 2级弹窗 */}
      <Modal
        title={editRecord2 ? `编辑商圈（${parentForChild?.label}）` : `新增商圈（${parentForChild?.label}）`}
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
          <Form.Item label="商圈名称" name="label" rules={[{ required: true, message: '请输入商圈名称' }]}>
            <Input placeholder="如：三里屯商圈" />
          </Form.Item>
          <Form.Item label="描述" name="description">
            <Input placeholder="描述（选填）" />
          </Form.Item>
          <Form.Item label="排序" name="sort" initialValue={0}>
            <InputNumber min={0} style={{ width: '100%' }} placeholder="排序值" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

export default CityListPage
