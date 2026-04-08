import { useState, useEffect, useCallback } from 'react'
import { Clock, RefreshCw } from 'lucide-react'
import {
  Table, Button, Modal, Form, Input, InputNumber, Select, Alert, Space, message, Popconfirm, Tag,
} from 'antd'
import {
  PlusOutlined, EditOutlined, DeleteOutlined,
} from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import './TimeListPage.scss'

const API_BASE = 'https://store.quikms.com'

interface TimeItem {
  id: number
  label: string
  permission: string | null
  sort: number
  type: number
}

interface TimeListResponse {
  errno: number
  errmsg: string
  data: TimeItem[]
}

const TYPE_MAP: Record<number, { label: string; color: string }> = {
  1: { label: '上午', color: 'blue' },
  2: { label: '下午', color: 'orange' },
  3: { label: '晚上', color: 'purple' },
}

function TimeListPage() {
  const [times, setTimes] = useState<TimeItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [showDialog, setShowDialog] = useState(false)
  const [editRecord, setEditRecord] = useState<TimeItem | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [form] = Form.useForm()

  const fetchTimes = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`${API_BASE}/admin/time/list`)
      const json: TimeListResponse = await res.json()
      if (json.errno === 0) {
        setTimes(json.data || [])
      } else {
        setError(json.errmsg || '请求失败')
      }
    } catch (e: any) {
      setError(e.message || '网络请求失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchTimes()
  }, [fetchTimes])

  // ---- 新增/编辑 ----

  const openAdd = () => {
    setEditRecord(null)
    form.resetFields()
    setShowDialog(true)
  }

  const openEdit = (record: TimeItem) => {
    setEditRecord(record)
    form.setFieldsValue({
      label: record.label,
      type: record.type,
      sort: record.sort,
    })
    setShowDialog(true)
  }

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields()
      setSubmitting(true)
      const body: any = {
        label: values.label?.trim(),
        type: values.type,
        sort: values.sort ?? 0,
      }
      if (editRecord) body.id = editRecord.id

      const res = await fetch(`${API_BASE}/admin/time/put`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (json.errno === 0) {
        message.success(editRecord ? '编辑成功' : '新增成功')
        setShowDialog(false)
        fetchTimes()
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
      const res = await fetch(`${API_BASE}/admin/time/delete?id=${id}`)
      const json = await res.json()
      if (json.errno === 0) {
        message.success('删除成功')
        fetchTimes()
      } else {
        message.error(json.errmsg || '删除失败')
      }
    } catch {
      message.error('删除请求失败')
    }
  }

  // ---- 表格列 ----

  const columns: ColumnsType<TimeItem> = [
    {
      title: 'ID',
      dataIndex: 'id',
      key: 'id',
      width: 70,
      align: 'center',
    },
    {
      title: '时间段',
      dataIndex: 'label',
      key: 'label',
      width: 160,
    },
    {
      title: '时段类型',
      dataIndex: 'type',
      key: 'type',
      width: 100,
      align: 'center',
      render: (type: number) => {
        const info = TYPE_MAP[type]
        return info ? <Tag color={info.color}>{info.label}</Tag> : '-'
      },
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
      render: (_: unknown, record: TimeItem) => (
        <Space size="small">
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEdit(record)}>
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

  return (
    <div className="time-list-page">
      <div className="time-page-header">
        <div className="time-page-title">
          <Clock size={24} />
          <h2>基础时间</h2>
        </div>
        <Space>
          <span className="time-count">共 {times.length} 个时间段</span>
          <Button type="primary" icon={<PlusOutlined />} onClick={openAdd}>
            新增时间段
          </Button>
          <Button
            icon={<RefreshCw size={14} className={loading ? 'spinning' : ''} />}
            onClick={fetchTimes}
            disabled={loading}
          >
            刷新
          </Button>
        </Space>
      </div>

      {error && (
        <Alert type="error" message={error} closable onClose={() => setError('')} style={{ marginBottom: 16 }} />
      )}

      <Table<TimeItem>
        columns={columns}
        dataSource={times}
        rowKey="id"
        loading={loading}
        pagination={{
          showTotal: (t) => `共 ${t} 条`,
          showSizeChanger: true,
          showQuickJumper: true,
          pageSizeOptions: ['10', '20', '50'],
          defaultPageSize: 10,
        }}
        size="middle"
      />

      {/* 新增/编辑弹窗 */}
      <Modal
        title={editRecord ? '编辑时间段' : '新增时间段'}
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
          <Form.Item label="时间段" name="label" rules={[{ required: true, message: '请输入时间段，如 10:00-10:30' }]}>
            <Input placeholder="如：10:00-10:30" />
          </Form.Item>
          <Form.Item label="时段类型" name="type" rules={[{ required: true, message: '请选择时段类型' }]}>
            <Select placeholder="请选择时段类型">
              <Select.Option value={1}>上午</Select.Option>
              <Select.Option value={2}>下午</Select.Option>
              <Select.Option value={3}>晚上</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item label="排序" name="sort" initialValue={0}>
            <InputNumber min={0} style={{ width: '100%' }} placeholder="排序值" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

export default TimeListPage
