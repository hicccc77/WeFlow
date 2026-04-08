import { useState, useEffect, useCallback } from 'react'
import { UserCog, RefreshCw } from 'lucide-react'
import {
  Table, Button, Modal, Form, Input, Select,
  Alert, Space, message, Popconfirm, Tag, Avatar,
} from 'antd'
import {
  PlusOutlined, EditOutlined, DeleteOutlined, UserOutlined,
} from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import './ManagerListPage.scss'

const API_BASE = 'https://store.quikms.com'

interface ManagerItem {
  id: number
  name: string
  avatar: string | null
  phone: string | null
  shop_id: number | null
  status: number
  create_time: string | null
  gmt_last_login: string | null
  shop_name?: string
}

interface ShopOption {
  id: number
  name: string | null
}

interface PageResponse<T> {
  errno: number
  errmsg: string
  data: {
    count: number
    totalPages: number
    pageSize: number
    currentPage: number
    data: T[]
  }
}

function ManagerListPage() {
  const [managers, setManagers] = useState<ManagerItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [currentPage, setCurrentPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [pageSize, setPageSize] = useState(10)
  const [filterShopId, setFilterShopId] = useState<number | undefined>(undefined)

  const [shops, setShops] = useState<ShopOption[]>([])

  // 新增/编辑弹窗
  const [showDialog, setShowDialog] = useState(false)
  const [editRecord, setEditRecord] = useState<ManagerItem | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [form] = Form.useForm()

  const isAddMode = !editRecord

  // ---- 加载门店列表 ----

  const fetchShops = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/admin/shop/list?page=1&size=200`)
      const json = await res.json()
      if (json.errno === 0) {
        setShops((json.data.data || []).filter((s: any) => s.name))
      }
    } catch {
      // ignore
    }
  }, [])

  // ---- 加载店长数据（必须传 shop_id） ----

  const fetchManagers = useCallback(async (shopId: number, page: number = 1, size?: number) => {
    const actualSize = size || pageSize
    setLoading(true)
    setError('')
    try {
      const url = `${API_BASE}/admin/shop/managerList?page=${page}&size=${actualSize}&shop_id=${shopId}`
      const res = await fetch(url)
      const json: PageResponse<ManagerItem> = await res.json()
      if (json.errno === 0) {
        // 附加门店名称
        const shopNameMap: Record<number, string> = {}
        shops.forEach((s) => { if (s.name) shopNameMap[s.id] = s.name })
        const enriched = (json.data.data || []).map((item) => ({
          ...item,
          shop_name: shopNameMap[item.shop_id!] || undefined,
        }))
        setManagers(enriched)
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
  }, [pageSize, shops])

  // 初始化加载门店
  useEffect(() => {
    fetchShops()
  }, [fetchShops])

  // ---- 筛选门店 ----

  const handleFilterChange = (shopId: number | undefined) => {
    setFilterShopId(shopId)
    setManagers([])
    setTotal(0)
    setError('')
    if (!shopId) return
    setLoading(true)
    const url = `${API_BASE}/admin/shop/managerList?page=1&size=${pageSize}&shop_id=${shopId}`
    fetch(url)
      .then((res) => res.json())
      .then((json: PageResponse<ManagerItem>) => {
        if (json.errno === 0) {
          const shopNameMap: Record<number, string> = {}
          shops.forEach((s) => { if (s.name) shopNameMap[s.id] = s.name })
          const enriched = (json.data.data || []).map((item) => ({
            ...item,
            shop_name: shopNameMap[item.shop_id!] || undefined,
          }))
          setManagers(enriched)
          setTotal(json.data.count)
          setCurrentPage(json.data.currentPage)
        } else {
          setError(json.errmsg || '请求失败')
        }
      })
      .catch((e: any) => setError(e.message || '网络请求失败'))
      .finally(() => setLoading(false))
  }

  // ---- 新增/编辑 ----

  const openAdd = () => {
    setEditRecord(null)
    form.resetFields()
    // 新增时默认填入当前筛选的门店
    if (filterShopId) {
      form.setFieldsValue({ shop_id: filterShopId })
    }
    setShowDialog(true)
  }

  const openEdit = (record: ManagerItem) => {
    setEditRecord(record)
    form.setFieldsValue({
      name: record.name || '',
      phone: record.phone || '',
      shop_id: record.shop_id || undefined,
    })
    setShowDialog(true)
  }

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields()
      setSubmitting(true)
      const body: any = {
        name: values.name?.trim(),
        phone: values.phone?.trim() || null,
        shop_id: values.shop_id,
      }
      if (editRecord) body.id = editRecord.id

      const res = await fetch(`${API_BASE}/admin/shop/managerPut`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (json.errno === 0) {
        message.success(editRecord ? '编辑成功' : '新增成功')
        setShowDialog(false)
        if (filterShopId) {
          fetchManagers(filterShopId, currentPage)
        }
      } else {
        message.error(json.errmsg || '操作失败')
      }
    } catch {
      // validateFields 失败
    } finally {
      setSubmitting(false)
    }
  }

  // ---- 删除 ----

  const handleDelete = async (id: number) => {
    try {
      const res = await fetch(`${API_BASE}/admin/manager/del?id=${id}`)
      const json = await res.json()
      if (json.errno === 0) {
        message.success('删除成功')
        if (filterShopId) {
          fetchManagers(filterShopId, currentPage)
        }
      } else {
        message.error(json.errmsg || '删除失败')
      }
    } catch {
      message.error('删除请求失败')
    }
  }

  // ---- 状态 Tag ----

  const statusTag = (status: number) => {
    if (status === 1) return <Tag color="green">启用</Tag>
    return <Tag color="default">禁用</Tag>
  }

  // ---- 表格列 ----

  const columns: ColumnsType<ManagerItem> = [
    {
      title: 'ID',
      dataIndex: 'id',
      key: 'id',
      width: 60,
      align: 'center',
    },
    {
      title: '头像',
      dataIndex: 'avatar',
      key: 'avatar',
      width: 70,
      align: 'center',
      render: (v: string | null, record: ManagerItem) => (
        <Avatar src={v} icon={!v ? <UserOutlined /> : undefined} size={36}>
          {!v ? record.name?.[0] : undefined}
        </Avatar>
      ),
    },
    {
      title: '姓名',
      dataIndex: 'name',
      key: 'name',
      width: 120,
      render: (v: string | null) => v || <span style={{ color: '#999' }}>未填写</span>,
    },
    {
      title: '手机号',
      dataIndex: 'phone',
      key: 'phone',
      width: 130,
      render: (v: string | null) => v || '-',
    },
    {
      title: '所属门店',
      dataIndex: 'shop_name',
      key: 'shop_name',
      width: 160,
      render: (v: string | null) => v || '-',
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 80,
      align: 'center',
      render: (v: number) => statusTag(v),
    },
    {
      title: '创建时间',
      dataIndex: 'create_time',
      key: 'create_time',
      width: 160,
      render: (v: string | null) => v || '-',
    },
    {
      title: '最后登录',
      dataIndex: 'gmt_last_login',
      key: 'gmt_last_login',
      width: 160,
      render: (v: string | null) => v || '-',
    },
    {
      title: '操作',
      key: 'action',
      width: 150,
      align: 'center',
      fixed: 'right',
      render: (_: unknown, record: ManagerItem) => (
        <Space size="small">
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Popconfirm title="确认删除此店长？" onConfirm={() => handleDelete(record.id)} okText="确认" cancelText="取消">
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div className="manager-list-page">
      <div className="manager-page-header">
        <div className="manager-page-title">
          <UserCog size={24} />
          <h2>店长列表</h2>
        </div>
        <Space>
          <Select
            placeholder="请选择门店查看"
            allowClear
            style={{ width: 200 }}
            value={filterShopId}
            onChange={handleFilterChange}
            showSearch
            optionFilterProp="children"
          >
            {shops.map((s) => (
              <Select.Option key={s.id} value={s.id}>{s.name}</Select.Option>
            ))}
          </Select>
          <span className="manager-count">共 {total} 名店长</span>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={openAdd}
            disabled={!filterShopId}
          >
            新增店长
          </Button>
          <Button
            icon={<RefreshCw size={14} className={loading ? 'spinning' : ''} />}
            onClick={() => filterShopId && fetchManagers(filterShopId, currentPage)}
            disabled={loading || !filterShopId}
          >
            刷新
          </Button>
        </Space>
      </div>

      {error && (
        <Alert type="error" message={error} closable onClose={() => setError('')} style={{ marginBottom: 16 }} />
      )}

      {!filterShopId ? (
        <div style={{ textAlign: 'center', padding: '80px 0', color: 'var(--text-tertiary)' }}>
          <UserCog size={48} style={{ opacity: 0.3, marginBottom: 16 }} />
          <p>请先选择门店以查看店长列表</p>
        </div>
      ) : (
        <Table<ManagerItem>
          columns={columns}
          dataSource={managers}
          rowKey="id"
          loading={loading}
          scroll={{ x: 1000 }}
          pagination={{
            current: currentPage,
            total,
            pageSize,
            showTotal: (t) => `共 ${t} 条`,
            onChange: (page, newPageSize) => {
              if (newPageSize !== pageSize) {
                setPageSize(newPageSize)
                fetchManagers(filterShopId!, 1, newPageSize)
              } else {
                fetchManagers(filterShopId!, page)
              }
            },
            showSizeChanger: true,
            showQuickJumper: true,
            pageSizeOptions: ['10', '20', '50'],
          }}
          size="middle"
        />
      )}

      {/* 新增/编辑弹窗 */}
      <Modal
        title={editRecord ? '编辑店长' : '新增店长'}
        open={showDialog}
        onCancel={() => setShowDialog(false)}
        onOk={handleSubmit}
        okText={editRecord ? '保存' : '确认新增'}
        cancelText="取消"
        confirmLoading={submitting}
        destroyOnClose
        width={480}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item
            label="姓名"
            name="name"
            rules={isAddMode ? [{ required: true, message: '请输入姓名' }] : []}
          >
            <Input placeholder="请输入店长姓名" />
          </Form.Item>
          <Form.Item
            label="手机号"
            name="phone"
            rules={isAddMode ? [{ required: true, message: '请输入手机号' }] : []}
          >
            <Input placeholder="请输入手机号" maxLength={11} />
          </Form.Item>
          <Form.Item
            label="所属门店"
            name="shop_id"
            rules={isAddMode ? [{ required: true, message: '请选择所属门店' }] : []}
          >
            <Select placeholder="请选择所属门店" showSearch optionFilterProp="children">
              {shops.map((s) => (
                <Select.Option key={s.id} value={s.id}>{s.name}</Select.Option>
              ))}
            </Select>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

export default ManagerListPage
