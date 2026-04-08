import { useState, useEffect } from 'react'
import { Building2, RefreshCw } from 'lucide-react'
import {
  Table, Button, Modal, Form, Input, Upload, Alert, Space, message,
} from 'antd'
import {
  PlusOutlined, EyeOutlined, UploadOutlined, LoadingOutlined,
  EditOutlined,
} from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import { uploadImageToOss } from '../utils/ossUpload'
import './CompanyListPage.scss'

interface CompanyItem {
  id: number
  name: string
  logo: string
  introduction: string | null
  name_short: string | null
  remark: string | null
}

interface CompanyListResponse {
  errno: number
  errmsg: string
  data: {
    count: number
    totalPages: number
    pageSize: number
    currentPage: number
    data: CompanyItem[]
  }
}

const API_BASE = 'https://store.quikms.com'

function CompanyListPage() {
  const [companies, setCompanies] = useState<CompanyItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [currentPage, setCurrentPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [pageSize, setPageSize] = useState(10)

  const [detailContent, setDetailContent] = useState<{ title: string; content: string } | null>(null)

  // 新增企业
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [addLoading, setAddLoading] = useState(false)
  const [addForm] = Form.useForm()
  const [addLogoUrl, setAddLogoUrl] = useState('')
  const [addUploading, setAddUploading] = useState(false)

  // 编辑企业
  const [editRecord, setEditRecord] = useState<CompanyItem | null>(null)
  const [editLoading, setEditLoading] = useState(false)
  const [editForm] = Form.useForm()
  const [editLogoUrl, setEditLogoUrl] = useState('')
  const [editUploading, setEditUploading] = useState(false)

  const fetchCompanies = async (page: number = 1, size?: number) => {
    const actualSize = size || pageSize
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`${API_BASE}/admin/company/list?page=${page}&size=${actualSize}`)
      const json: CompanyListResponse = await res.json()
      if (json.errno === 0) {
        setCompanies(json.data.data || [])
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
  }

  useEffect(() => {
    fetchCompanies(1)
  }, [])

  // ---- 新增 ----

  const handleAddSuccess = () => {
    setShowAddDialog(false)
    addForm.resetFields()
    setAddLogoUrl('')
    fetchCompanies(1)
  }

  const handleAddLogoUpload = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      message.error('请选择图片文件')
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      message.error('图片大小不能超过 5MB')
      return
    }
    setAddUploading(true)
    try {
      const url = await uploadImageToOss(file)
      setAddLogoUrl(url)
    } catch (err: any) {
      message.error('Logo 上传失败：' + (err.message || '未知错误'))
    } finally {
      setAddUploading(false)
    }
  }

  const handleAddSubmit = async () => {
    try {
      const values = await addForm.validateFields()
      if (!addLogoUrl) {
        message.error('请上传企业 Logo')
        return
      }
      setAddLoading(true)
      const res = await fetch(`${API_BASE}/admin/company/put`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: values.name?.trim(),
          name_short: values.name_short?.trim(),
          logo: addLogoUrl,
          introduction: values.introduction?.trim() || null,
          remark: values.remark?.trim() || null,
        }),
      })
      const json = await res.json()
      if (json.errno === 0) {
        message.success('新增企业成功')
        handleAddSuccess()
      } else {
        message.error(json.errmsg || '新增失败')
      }
    } catch {
      // validateFields 失败
    } finally {
      setAddLoading(false)
    }
  }

  // ---- 编辑 ----

  const openEditDialog = (record: CompanyItem) => {
    setEditRecord(record)
    setEditLogoUrl(record.logo || '')
    editForm.setFieldsValue({
      name: record.name,
      name_short: record.name_short || '',
      introduction: record.introduction || '',
      remark: record.remark || '',
    })
  }

  const closeEditDialog = () => {
    setEditRecord(null)
    editForm.resetFields()
    setEditLogoUrl('')
  }

  const handleEditLogoUpload = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      message.error('请选择图片文件')
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      message.error('图片大小不能超过 5MB')
      return
    }
    setEditUploading(true)
    try {
      const url = await uploadImageToOss(file)
      setEditLogoUrl(url)
    } catch (err: any) {
      message.error('Logo 上传失败：' + (err.message || '未知错误'))
    } finally {
      setEditUploading(false)
    }
  }

  const handleEditSubmit = async () => {
    try {
      const values = await editForm.validateFields()
      setEditLoading(true)
      const res = await fetch(`${API_BASE}/admin/company/put`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: editRecord!.id,
          name: values.name?.trim(),
          name_short: values.name_short?.trim(),
          logo: editLogoUrl,
          introduction: values.introduction?.trim() || null,
          remark: values.remark?.trim() || null,
        }),
      })
      const json = await res.json()
      if (json.errno === 0) {
        message.success('编辑成功')
        closeEditDialog()
        fetchCompanies(currentPage)
      } else {
        message.error(json.errmsg || '编辑失败')
      }
    } catch {
      // validateFields 失败
    } finally {
      setEditLoading(false)
    }
  }

  // ---- 表格列 ----

  const columns: ColumnsType<CompanyItem> = [
    {
      title: 'ID',
      dataIndex: 'id',
      key: 'id',
      width: 70,
      fixed: 'left',
      align: 'center',
    },
    {
      title: 'Logo',
      dataIndex: 'logo',
      key: 'logo',
      width: 70,
      align: 'center',
      render: (logo: string) =>
        logo ? (
          <img src={logo} alt="logo" className="company-logo-img" />
        ) : (
          <span style={{ color: '#999' }}>-</span>
        ),
    },
    {
      title: '企业名称',
      dataIndex: 'name',
      key: 'name',
      width: 200,
      render: (name: string) => (
        <a onClick={() => setDetailContent({ title: '企业名称', content: name })}>{name}</a>
      ),
    },
    {
      title: '企业简称',
      dataIndex: 'name_short',
      key: 'name_short',
      width: 120,
      render: (v: string | null) => v || '-',
    },
    {
      title: '企业介绍',
      dataIndex: 'introduction',
      key: 'introduction',
      width: 120,
      render: (v: string | null) =>
        v ? (
          <a onClick={() => setDetailContent({ title: '企业介绍', content: v })}>
            <EyeOutlined /> 查看介绍
          </a>
        ) : (
          '-'
        ),
    },
    {
      title: '备注',
      dataIndex: 'remark',
      key: 'remark',
      width: 150,
      render: (v: string | null) =>
        v ? (
          <a onClick={() => setDetailContent({ title: '备注', content: v })}>
            {v.length > 20 ? v.slice(0, 20) + '...' : v}
          </a>
        ) : (
          '-'
        ),
    },
    {
      title: '操作',
      key: 'action',
      width: 80,
      fixed: 'right',
      align: 'center',
      render: (_: unknown, record: CompanyItem) => (
        <Button
          type="link"
          size="small"
          icon={<EditOutlined />}
          onClick={() => openEditDialog(record)}
        >
          编辑
        </Button>
      ),
    },
  ]

  // ---- Logo 上传 UI（新增 & 编辑共用） ----

  const renderLogoUploadArea = (
    logoUrl: string,
    uploading: boolean,
    onUpload: (file: File) => void,
  ) => (
    <div className="logo-upload-area">
      {logoUrl ? (
        <>
          <div className="logo-preview">
            <img src={logoUrl} alt="Logo 预览" />
            <div className="logo-preview-overlay">
              <PlusOutlined style={{ fontSize: 20 }} />
              <span>更换</span>
            </div>
          </div>
          <Upload
            showUploadList={false}
            beforeUpload={(file) => { onUpload(file); return false }}
            accept="image/*"
          >
            <Button size="small" style={{ marginTop: 8 }} loading={uploading}>
              <UploadOutlined /> 更换 Logo
            </Button>
          </Upload>
        </>
      ) : (
        <Upload
          showUploadList={false}
          beforeUpload={(file) => { onUpload(file); return false }}
          accept="image/*"
        >
          <button
            className="logo-upload-placeholder"
            style={{ border: 'none', background: 'none', cursor: uploading ? 'not-allowed' : 'pointer' }}
          >
            {uploading ? (
              <>
                <LoadingOutlined style={{ fontSize: 24 }} />
                <span>上传中...</span>
              </>
            ) : (
              <>
                <UploadOutlined style={{ fontSize: 24 }} />
                <span>点击上传 Logo</span>
              </>
            )}
          </button>
        </Upload>
      )}
    </div>
  )

  return (
    <div className="company-list-page">
      <div className="company-page-header">
        <div className="company-page-title">
          <Building2 size={24} />
          <h2>企业列表</h2>
        </div>
        <Space>
          <span className="company-count">共 {total} 家企业</span>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => setShowAddDialog(true)}
          >
            新增企业
          </Button>
          <Button
            icon={<RefreshCw size={14} className={loading ? 'spinning' : ''} />}
            onClick={() => fetchCompanies(currentPage)}
            disabled={loading}
          >
            刷新
          </Button>
        </Space>
      </div>

      {error && (
        <Alert
          type="error"
          message={error}
          closable
          onClose={() => setError('')}
          style={{ marginBottom: 16 }}
        />
      )}

      <Table<CompanyItem>
        columns={columns}
        dataSource={companies}
        rowKey="id"
        loading={loading}
        scroll={{ x: 800 }}
        pagination={{
          current: currentPage,
          total,
          pageSize,
          showTotal: (t) => `共 ${t} 条`,
          onChange: (page, newPageSize) => {
            if (newPageSize !== pageSize) {
              setPageSize(newPageSize)
              fetchCompanies(1, newPageSize)
            } else {
              fetchCompanies(page)
            }
          },
          showSizeChanger: true,
          showQuickJumper: true,
          pageSizeOptions: ['10', '20', '50'],
        }}
        size="middle"
      />

      {/* 详情弹窗 */}
      <Modal
        title={detailContent?.title}
        open={!!detailContent}
        onCancel={() => setDetailContent(null)}
        footer={null}
        width={480}
      >
        <p style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', lineHeight: 1.8 }}>
          {detailContent?.content}
        </p>
      </Modal>

      {/* 新增企业弹窗 */}
      <Modal
        title="新增企业"
        open={showAddDialog}
        onCancel={() => {
          setShowAddDialog(false)
          addForm.resetFields()
          setAddLogoUrl('')
        }}
        onOk={handleAddSubmit}
        okText="确认新增"
        cancelText="取消"
        confirmLoading={addLoading}
        okButtonProps={{ disabled: !addLogoUrl || addUploading }}
        width={520}
        destroyOnClose
      >
        <Form form={addForm} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item label="企业名称" name="name" rules={[{ required: true, message: '请输入企业名称' }]}>
            <Input placeholder="请输入企业名称" />
          </Form.Item>
          <Form.Item label="企业简称" name="name_short" rules={[{ required: true, message: '请输入企业简称' }]}>
            <Input placeholder="请输入企业简称" />
          </Form.Item>
          <Form.Item label="企业 Logo" required>
            {renderLogoUploadArea(addLogoUrl, addUploading, handleAddLogoUpload)}
          </Form.Item>
          <Form.Item label="企业介绍" name="introduction">
            <Input.TextArea placeholder="请输入企业介绍（选填）" rows={3} />
          </Form.Item>
          <Form.Item label="备注" name="remark">
            <Input.TextArea placeholder="请输入备注（选填）" rows={2} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 编辑企业弹窗 */}
      <Modal
        title="编辑企业"
        open={!!editRecord}
        onCancel={closeEditDialog}
        onOk={handleEditSubmit}
        okText="保存修改"
        cancelText="取消"
        confirmLoading={editLoading}
        okButtonProps={{ disabled: editUploading }}
        width={520}
        destroyOnClose
      >
        <Form form={editForm} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item label="企业名称" name="name">
            <Input placeholder="请输入企业名称" />
          </Form.Item>
          <Form.Item label="企业简称" name="name_short">
            <Input placeholder="请输入企业简称" />
          </Form.Item>
          <Form.Item label="企业 Logo">
            {renderLogoUploadArea(editLogoUrl, editUploading, handleEditLogoUpload)}
          </Form.Item>
          <Form.Item label="企业介绍" name="introduction">
            <Input.TextArea placeholder="请输入企业介绍（选填）" rows={3} />
          </Form.Item>
          <Form.Item label="备注" name="remark">
            <Input.TextArea placeholder="请输入备注（选填）" rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

export default CompanyListPage
