import { useState, useEffect, useCallback, useRef } from 'react'
import { Store, RefreshCw } from 'lucide-react'
import {
  Table, Button, Modal, Form, Input, InputNumber, Select, Cascader,
  Alert, Space, message, Popconfirm, Tag, Upload, Image,
} from 'antd'
import {
  PlusOutlined, EditOutlined, DeleteOutlined, UploadOutlined,
  LoadingOutlined, PictureOutlined, GiftOutlined, ClockCircleOutlined,
  EnvironmentOutlined,
} from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import { uploadImageToOss } from '../utils/ossUpload'
import './ShopListPage.scss'

const API_BASE = 'https://store.quikms.com'
const TENCENT_MAP_KEY = 'MMTBZ-FFMCL-SY6PC-E5SVR-BNGDH-7VFLU'

// ---- JSONP 工具 ----
function jsonp(url: string, params: Record<string, string>): Promise<any> {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams(params).toString()
    const callbackName = `jsonp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const script = document.createElement('script')
    const fullUrl = `${url}?${qs}&callback=${callbackName}`

    const cleanup = () => {
      delete (window as any)[callbackName]
      script.remove()
    }

    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('请求超时'))
    }, 10000)

    ;(window as any)[callbackName] = (data: any) => {
      clearTimeout(timer)
      cleanup()
      resolve(data)
    }

    script.src = fullUrl
    script.onerror = () => {
      clearTimeout(timer)
      cleanup()
      reject(new Error('JSONP 请求失败'))
    }
    document.head.appendChild(script)
  })
}

// ---- 腾讯地图地点搜索（返回候选列表）----
interface MapSuggestion {
  title: string
  address: string
  location: { lat: number; lng: number }
  province: string
  city: string
  district: string
}

async function searchPlaceSuggestions(keyword: string): Promise<MapSuggestion[]> {
  const qs = new URLSearchParams({
    keyword,
    key: TENCENT_MAP_KEY,
    output: 'json',
  }).toString()
  const res = await fetch(`https://apis.map.qq.com/ws/place/v1/suggestion?${qs}`)
  const data = await res.json()
  if (data.status !== 0) {
    throw new Error(data.message || '搜索失败')
  }
  return (data.data || []).map((item: any) => ({
    title: item.title,
    address: item.address,
    location: item.location,
    province: item.province,
    city: item.city,
    district: item.district,
  }))
}

// ---- 数据类型 ----
interface ShopItem {
  id: number
  company_id: number | null
  name: string | null
  address: string | null
  lng: number | null
  lat: number | null
  city: number | null
  status: number
  manager_id: number | null
  time: string | null
  create_time: string | null
  company_name: string | null
  manager_name: string | null
  district_id: number[] | null
  district_name: string[] | null
}

interface ShopImg {
  id: number
  shop_id: number
  url: string
  sort: number
  create_time: string | null
}

interface BenefitItem {
  id: number
  label: string
  sort: number
  shop_id: number
}

interface TimeItem {
  id: number
  label: string
  sort: number
  type: number
  selected?: boolean
}

interface CompanyItem {
  id: number
  name: string | null
  name_short: string | null
}

interface CascaderOption {
  id: number
  label: string
  children?: CascaderOption[]
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

const STATUS_MAP: Record<number, { text: string; color: string }> = {
  0: { text: '正常', color: 'green' },
  1: { text: '已关闭', color: 'red' },
}

function ShopListPage() {
  const [shops, setShops] = useState<ShopItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [currentPage, setCurrentPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [pageSize, setPageSize] = useState(10)

  // 下拉数据源
  const [companies, setCompanies] = useState<CompanyItem[]>([])
  const [cascaderOptions, setCascaderOptions] = useState<CascaderOption[]>([])
  const [allTimes, setAllTimes] = useState<TimeItem[]>([])

  // 编辑弹窗
  const [showEdit, setShowEdit] = useState(false)
  const [editRecord, setEditRecord] = useState<ShopItem | null>(null)
  const [editLoading, setEditLoading] = useState(false)
  const [editForm] = Form.useForm()
  // 图片管理弹窗
  const [showImg, setShowImg] = useState(false)
  const [imgShopId, setImgShopId] = useState<number>(0)
  const [imgList, setImgList] = useState<ShopImg[]>([])
  const [imgLoading, setImgLoading] = useState(false)
  const [imgUploading, setImgUploading] = useState(false)

  // 福利管理弹窗
  const [showBenefits, setShowBenefits] = useState(false)
  const [benefitShopId, setBenefitShopId] = useState<number>(0)
  const [benefits, setBenefits] = useState<BenefitItem[]>([])
  const [benefitLoading, setBenefitLoading] = useState(false)
  const [addBenefitVisible, setAddBenefitVisible] = useState(false)
  const [benefitForm] = Form.useForm()

  // 时间配置弹窗
  const [showTimeConfig, setShowTimeConfig] = useState(false)
  const [timeConfigShopId, setTimeConfigShopId] = useState<number>(0)
  const [selectedTimes, setSelectedTimes] = useState<number[]>([])
  const [timeConfigLoading, setTimeConfigLoading] = useState(false)

  const isAddMode = !editRecord

  // ---- 加载数据 ----

  const fetchShops = useCallback(async (page: number = 1, size?: number) => {
    const actualSize = size || pageSize
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`${API_BASE}/admin/shop/list?page=${page}&size=${actualSize}`)
      const json: PageResponse<ShopItem> = await res.json()
      if (json.errno === 0) {
        setShops(json.data.data || [])
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

  const loadDropdownData = useCallback(async () => {
    try {
      const [companyRes, cascaderRes, timeRes] = await Promise.all([
        fetch(`${API_BASE}/admin/company/list?page=1&size=200`),
        fetch(`${API_BASE}/admin/city/cascader`),
        fetch(`${API_BASE}/admin/time/list`),
      ])
      const companyJson = await companyRes.json()
      if (companyJson.errno === 0) {
        setCompanies(companyJson.data.data || [])
      }
      const cascaderJson = await cascaderRes.json()
      if (cascaderJson.errno === 0) {
        setCascaderOptions(cascaderJson.data || [])
      }
      const timeJson = await timeRes.json()
      if (timeJson.errno === 0) {
        setAllTimes(timeJson.data || [])
      }
    } catch (e) {
      console.error('加载下拉数据失败:', e)
    }
  }, [])

  useEffect(() => {
    fetchShops(1)
    loadDropdownData()
  }, [fetchShops, loadDropdownData])

  // ---- 新增/编辑门店 ----

  const openEdit = (record: ShopItem) => {
    setEditRecord(record)
    editForm.setFieldsValue({
      name: record.name || '',
      company_id: record.company_id || undefined,
      address: record.address || '',
      lng: record.lng,
      lat: record.lat,
      district_id: (record.district_id && record.district_id.length > 0) ? record.district_id : undefined,
      status: record.status ?? 0,
      time: record.time ? record.time.split(',').map(Number) : [],
    })
    setShowEdit(true)
  }

  const openAdd = () => {
    setEditRecord(null)
    editForm.resetFields()
    setShowEdit(true)
  }

  const handleEditSubmit = async () => {
    try {
      const values = await editForm.validateFields()
      setEditLoading(true)
      const body: any = {
        name: values.name?.trim(),
        company_id: values.company_id,
        address: values.address?.trim() || null,
        lng: values.lng ?? null,
        lat: values.lat ?? null,
        district: values.district_id?.length ? values.district_id : null,
        status: values.status ?? 0,
        time: values.time ? values.time.join(',') : null,
      }
      if (editRecord) body.id = editRecord.id

      const res = await fetch(`${API_BASE}/admin/shop/put`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (json.errno === 0) {
        message.success(editRecord ? '编辑成功' : '新增成功')
        setShowEdit(false)
        fetchShops(currentPage)
      } else {
        message.error(json.errmsg || '操作失败')
      }
    } catch {
      // validateFields 失败
    } finally {
      setEditLoading(false)
    }
  }

  // ---- 腾讯地图选点 ----
  const [showMapPicker, setShowMapPicker] = useState(false)
  const [mapReady, setMapReady] = useState(false)
  const mapRef = useRef<HTMLDivElement>(null)
  const mapInstanceRef = useRef<any>(null)
  const markerRef = useRef<any>(null)
  const [pickedLng, setPickedLng] = useState<number | null>(null)
  const [pickedLat, setPickedLat] = useState<number | null>(null)

  // 加载腾讯地图 JS SDK
  const loadTencentMap = useCallback(() => {
    return new Promise<void>((resolve, reject) => {
      if ((window as any).TMap) {
        resolve()
        return
      }
      const script = document.createElement('script')
      script.src = `https://map.qq.com/api/gljs?v=1.exp&key=${TENCENT_MAP_KEY}`
      script.onload = () => resolve()
      script.onerror = () => reject(new Error('地图 SDK 加载失败'))
      document.head.appendChild(script)
    })
  }, [])

  const openMapPicker = async () => {
    const curLng = editForm.getFieldValue('lng')
    const curLat = editForm.getFieldValue('lat')
    setPickedLng(curLng ?? null)
    setPickedLat(curLat ?? null)
    setShowMapPicker(true)

    try {
      await loadTencentMap()
      setMapReady(true)
      // 等待 DOM 渲染
      setTimeout(() => {
        if (!mapRef.current || !(window as any).TMap) return
        const TMap = (window as any).TMap
        const center = curLng && curLat
          ? new TMap.LatLng(curLat, curLng)
          : new TMap.LatLng(39.984104, 116.307503) // 默认北京
        const map = new TMap.Map(mapRef.current, {
          center,
          zoom: 13,
        })
        mapInstanceRef.current = map

        // 如果已有坐标，添加 marker
        if (curLng && curLat) {
          const marker = new TMap.MultiMarker({
            map,
            geometries: [{
              id: 'picked',
              position: new TMap.LatLng(curLat, curLng),
            }],
          })
          markerRef.current = marker
        }

        // 点击地图获取坐标
        map.on('click', (evt: any) => {
          const { lat, lng } = evt.latLng
          setPickedLat(lat)
          setPickedLng(lng)
          // 更新 marker
          if (markerRef.current) {
            markerRef.current.setGeometries([{
              id: 'picked',
              position: new TMap.LatLng(lat, lng),
            }])
          } else {
            markerRef.current = new TMap.MultiMarker({
              map,
              geometries: [{
                id: 'picked',
                position: new TMap.LatLng(lat, lng),
              }],
            })
          }
        })
      }, 200)
    } catch (err: any) {
      message.error('地图加载失败：' + (err.message || '未知错误'))
    }
  }

  const confirmMapPick = () => {
    if (pickedLng !== null && pickedLat !== null) {
      editForm.setFieldsValue({ lng: pickedLng, lat: pickedLat })
      message.success(`已选坐标：${pickedLng}, ${pickedLat}`)
    }
    setShowMapPicker(false)
    setMapReady(false)
    if (mapInstanceRef.current) {
      mapInstanceRef.current.destroy()
      mapInstanceRef.current = null
    }
    markerRef.current = null
  }

  const cancelMapPick = () => {
    setShowMapPicker(false)
    setMapReady(false)
    if (mapInstanceRef.current) {
      mapInstanceRef.current.destroy()
      mapInstanceRef.current = null
    }
    markerRef.current = null
  }

  // 地图搜索 - 实时联想
  const [mapSearchText, setMapSearchText] = useState('')
  const [suggestions, setSuggestions] = useState<MapSuggestion[]>([])
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleMapInputChange = (value: string) => {
    setMapSearchText(value)
    // 清除之前的定时器
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    // 清空时隐藏候选
    if (!value.trim()) {
      setSuggestions([])
      return
    }
    // 防抖 300ms 后请求
    searchTimerRef.current = setTimeout(async () => {
      try {
        const list = await searchPlaceSuggestions(value.trim())
        setSuggestions(list.slice(0, 8))
      } catch {
        setSuggestions([])
      }
    }, 300)
  }

  const handleSelectSuggestion = (item: MapSuggestion) => {
    const { lng, lat } = item.location
    setPickedLng(lng)
    setPickedLat(lat)
    setSuggestions([])
    setMapSearchText(item.title)
    if (mapInstanceRef.current && (window as any).TMap) {
      const TMap = (window as any).TMap
      mapInstanceRef.current.setCenter(new TMap.LatLng(lat, lng))
      mapInstanceRef.current.setZoom(16)
      if (markerRef.current) {
        markerRef.current.setGeometries([{
          id: 'picked',
          position: new TMap.LatLng(lat, lng),
        }])
      } else {
        markerRef.current = new TMap.MultiMarker({
          map: mapInstanceRef.current,
          geometries: [{
            id: 'picked',
            position: new TMap.LatLng(lat, lng),
          }],
        })
      }
    }
  }

  // ---- 图片管理 ----

  const openImgManager = async (shopId: number) => {
    setImgShopId(shopId)
    setShowImg(true)
    setImgLoading(true)
    try {
      const res = await fetch(`${API_BASE}/admin/shop/imgList?shop_id=${shopId}`)
      const json = await res.json()
      if (json.errno === 0) {
        setImgList(json.data || [])
      }
    } catch {
      message.error('加载图片失败')
    } finally {
      setImgLoading(false)
    }
  }

  const handleImgUpload = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      message.error('请选择图片文件')
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      message.error('图片大小不能超过 5MB')
      return
    }
    setImgUploading(true)
    try {
      const url = await uploadImageToOss(file)
      await fetch(`${API_BASE}/admin/shop/imgPut`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shop_id: imgShopId, url }),
      })
      message.success('上传成功')
      openImgManager(imgShopId)
    } catch (err: any) {
      message.error('上传失败：' + (err.message || '未知错误'))
    } finally {
      setImgUploading(false)
    }
  }

  const handleImgDelete = async (imgId: number) => {
    try {
      const res = await fetch(`${API_BASE}/admin/shop/imgDel?id=${imgId}`)
      const json = await res.json()
      if (json.errno === 0) {
        message.success('删除成功')
        openImgManager(imgShopId)
      } else {
        message.error(json.errmsg || '删除失败')
      }
    } catch {
      message.error('删除请求失败')
    }
  }

  // ---- 福利管理 ----

  const openBenefitManager = async (shopId: number) => {
    setBenefitShopId(shopId)
    setShowBenefits(true)
    setBenefitLoading(true)
    try {
      const res = await fetch(`${API_BASE}/admin/benefits/list?shop_id=${shopId}`)
      const json = await res.json()
      if (json.errno === 0) {
        setBenefits(json.data || [])
      }
    } catch {
      message.error('加载福利列表失败')
    } finally {
      setBenefitLoading(false)
    }
  }

  const handleAddBenefit = async () => {
    try {
      const values = await benefitForm.validateFields()
      setBenefitLoading(true)
      const res = await fetch(`${API_BASE}/admin/benefits/put`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shop_id: benefitShopId,
          label: values.label?.trim(),
          sort: values.sort ?? 0,
        }),
      })
      const json = await res.json()
      if (json.errno === 0) {
        message.success('添加成功')
        setAddBenefitVisible(false)
        benefitForm.resetFields()
        openBenefitManager(benefitShopId)
      } else {
        message.error(json.errmsg || '添加失败')
      }
    } catch {
      // validateFields 失败
    } finally {
      setBenefitLoading(false)
    }
  }

  const handleDeleteBenefit = async (id: number) => {
    try {
      const res = await fetch(`${API_BASE}/admin/benefits/del?id=${id}`)
      const json = await res.json()
      if (json.errno === 0) {
        message.success('删除成功')
        openBenefitManager(benefitShopId)
      } else {
        message.error(json.errmsg || '删除失败')
      }
    } catch {
      message.error('删除请求失败')
    }
  }

  // ---- 时间配置 ----

  const openTimeConfig = async (shopId: number) => {
    setTimeConfigShopId(shopId)
    setTimeConfigLoading(true)
    setShowTimeConfig(true)
    try {
      const res = await fetch(`${API_BASE}/admin/time/shopTime?shop_id=${shopId}`)
      const json = await res.json()
      if (json.errno === 0) {
        const selected = (json.data || [])
          .filter((t: TimeItem) => t.selected)
          .map((t: TimeItem) => t.id)
        setSelectedTimes(selected)
      }
    } catch {
      message.error('加载时间配置失败')
    } finally {
      setTimeConfigLoading(false)
    }
  }

  const handleSaveTimeConfig = async () => {
    setTimeConfigLoading(true)
    try {
      const res = await fetch(`${API_BASE}/admin/shop/put`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: timeConfigShopId,
          time: selectedTimes.join(','),
        }),
      })
      const json = await res.json()
      if (json.errno === 0) {
        message.success('时间配置已保存')
        setShowTimeConfig(false)
        fetchShops(currentPage)
      } else {
        message.error(json.errmsg || '保存失败')
      }
    } catch {
      message.error('保存请求失败')
    } finally {
      setTimeConfigLoading(false)
    }
  }

  // ---- 表格列 ----

  const cascaderData = cascaderOptions.map((city) => ({
    value: city.id,
    label: city.label,
    children: (city.children || []).map((child) => ({
      value: child.id,
      label: child.label,
    })),
  }))

  const columns: ColumnsType<ShopItem> = [
    {
      title: 'ID',
      dataIndex: 'id',
      key: 'id',
      width: 60,
      fixed: 'left',
      align: 'center',
    },
    {
      title: '门店名称',
      dataIndex: 'name',
      key: 'name',
      width: 140,
      render: (v: string | null) => v || <span style={{ color: '#999' }}>未填写</span>,
    },
    {
      title: '所属公司',
      dataIndex: 'company_name',
      key: 'company_name',
      width: 160,
      render: (v: string | null) => v || '-',
    },
    {
      title: '商圈',
      dataIndex: 'district_name',
      key: 'district_name',
      width: 140,
      render: (v: string[] | null) => v ? v.join(' / ') : '-',
    },
    {
      title: '地址',
      dataIndex: 'address',
      key: 'address',
      width: 140,
      render: (v: string | null) => v || '-',
    },
    {
      title: '负责人',
      dataIndex: 'manager_name',
      key: 'manager_name',
      width: 90,
      render: (v: string | null) => v || '-',
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 80,
      align: 'center',
      render: (v: number) => {
        const info = STATUS_MAP[v] || { text: '未知', color: 'default' }
        return <Tag color={info.color}>{info.text}</Tag>
      },
    },
    {
      title: '创建时间',
      dataIndex: 'create_time',
      key: 'create_time',
      width: 160,
      render: (v: string | null) => v || '-',
    },
    {
      title: '操作',
      key: 'action',
      width: 280,
      fixed: 'right',
      align: 'center',
      render: (_: unknown, record: ShopItem) => (
        <Space size="small" wrap>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Button type="link" size="small" icon={<PictureOutlined />} onClick={() => openImgManager(record.id)}>
            图片
          </Button>
          <Button type="link" size="small" icon={<GiftOutlined />} onClick={() => openBenefitManager(record.id)}>
            福利
          </Button>
          <Button type="link" size="small" icon={<ClockCircleOutlined />} onClick={() => openTimeConfig(record.id)}>
            时间
          </Button>
        </Space>
      ),
    },
  ]

  const timeGroups = [
    { type: 1, label: '上午', times: allTimes.filter((t) => t.type === 1) },
    { type: 2, label: '下午', times: allTimes.filter((t) => t.type === 2) },
    { type: 3, label: '晚上', times: allTimes.filter((t) => t.type === 3) },
  ]

  return (
    <div className="shop-list-page">
      <div className="shop-page-header">
        <div className="shop-page-title">
          <Store size={24} />
          <h2>门店列表</h2>
        </div>
        <Space>
          <span className="shop-count">共 {total} 家门店</span>
          <Button type="primary" icon={<PlusOutlined />} onClick={openAdd}>
            新增门店
          </Button>
          <Button
            icon={<RefreshCw size={14} className={loading ? 'spinning' : ''} />}
            onClick={() => fetchShops(currentPage)}
            disabled={loading}
          >
            刷新
          </Button>
        </Space>
      </div>

      {error && (
        <Alert type="error" message={error} closable onClose={() => setError('')} style={{ marginBottom: 16 }} />
      )}

      <Table<ShopItem>
        columns={columns}
        dataSource={shops}
        rowKey="id"
        loading={loading}
        scroll={{ x: 1100 }}
        pagination={{
          current: currentPage,
          total,
          pageSize,
          showTotal: (t) => `共 ${t} 条`,
          onChange: (page, newPageSize) => {
            if (newPageSize !== pageSize) {
              setPageSize(newPageSize)
              fetchShops(1, newPageSize)
            } else {
              fetchShops(page)
            }
          },
          showSizeChanger: true,
          showQuickJumper: true,
          pageSizeOptions: ['10', '20', '50'],
        }}
        size="middle"
      />

      {/* 新增/编辑门店弹窗 */}
      <Modal
        title={editRecord ? '编辑门店' : '新增门店'}
        open={showEdit}
        onCancel={() => setShowEdit(false)}
        onOk={handleEditSubmit}
        okText={editRecord ? '保存' : '确认新增'}
        cancelText="取消"
        confirmLoading={editLoading}
        destroyOnClose
        width={560}
      >
        <Form form={editForm} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item
            label="门店名称"
            name="name"
            rules={isAddMode ? [{ required: true, message: '请输入门店名称' }] : []}
          >
            <Input placeholder="请输入门店名称" />
          </Form.Item>
          <Form.Item
            label="所属公司"
            name="company_id"
            rules={isAddMode ? [{ required: true, message: '请选择所属公司' }] : []}
          >
            <Select placeholder="请选择所属公司" showSearch optionFilterProp="children">
              {companies.filter((c) => c.name).map((c) => (
                <Select.Option key={c.id} value={c.id}>{c.name}</Select.Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item
            label="所在商圈"
            name="district_id"
            rules={isAddMode ? [{ required: true, message: '请选择所在商圈' }] : []}
          >
            <Cascader
              options={cascaderData}
              placeholder="请选择商圈（区域 / 商圈）"
              changeOnSelect
            />
          </Form.Item>
          <Form.Item label="地址" name="address" rules={isAddMode ? [{ required: true, message: '请输入地址' }] : []}>
            <Input placeholder="请输入详细地址" />
          </Form.Item>
          <Form.Item label="经纬度">
            <Space align="start" style={{ display: 'flex' }}>
              <Form.Item name="lng" noStyle>
                <InputNumber placeholder="经度" style={{ width: 140 }} disabled />
              </Form.Item>
              <Form.Item name="lat" noStyle>
                <InputNumber placeholder="纬度" style={{ width: 140 }} disabled />
              </Form.Item>
              <Button
                icon={<EnvironmentOutlined />}
                onClick={openMapPicker}
              >
                地图选点
              </Button>
            </Space>
          </Form.Item>
          <Form.Item label="状态" name="status">
            <Select>
              <Select.Option value={0}>正常</Select.Option>
              <Select.Option value={1}>已关闭</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item label="面试时间" name="time">
            <Select mode="multiple" placeholder="请选择面试时间段" optionFilterProp="children">
              {allTimes.map((t) => (
                <Select.Option key={t.id} value={t.id}>{t.label}</Select.Option>
              ))}
            </Select>
          </Form.Item>
        </Form>
      </Modal>

      {/* 图片管理弹窗 */}
      <Modal
        title="门店形象图片"
        open={showImg}
        onCancel={() => setShowImg(false)}
        footer={null}
        width={640}
      >
        <div style={{ marginBottom: 16 }}>
          <Upload
            showUploadList={false}
            beforeUpload={(file) => { handleImgUpload(file); return false }}
            accept="image/*"
          >
            <Button type="primary" icon={imgUploading ? <LoadingOutlined /> : <UploadOutlined />} loading={imgUploading}>
              上传图片
            </Button>
          </Upload>
        </div>
        {imgLoading ? (
          <div style={{ textAlign: 'center', padding: 40, color: '#999' }}>加载中...</div>
        ) : imgList.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 40, color: '#999' }}>暂无图片</div>
        ) : (
          <div className="shop-img-grid">
            {imgList.map((img) => (
              <div key={img.id} className="shop-img-item">
                <Image src={img.url} alt="门店图片" width={140} height={140} style={{ objectFit: 'cover', borderRadius: 8 }} />
                <Popconfirm title="确认删除此图片？" onConfirm={() => handleImgDelete(img.id)} okText="确认" cancelText="取消">
                  <Button type="text" danger size="small" icon={<DeleteOutlined />} style={{ marginTop: 4 }}>
                    删除
                  </Button>
                </Popconfirm>
              </div>
            ))}
          </div>
        )}
      </Modal>

      {/* 福利管理弹窗 */}
      <Modal
        title="门店福利标签"
        open={showBenefits}
        onCancel={() => { setShowBenefits(false); setAddBenefitVisible(false) }}
        footer={null}
        width={500}
      >
        <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>共 {benefits.length} 个标签</span>
          <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => setAddBenefitVisible(true)}>
            新增标签
          </Button>
        </div>

        {addBenefitVisible && (
          <div style={{ marginBottom: 16, padding: 12, background: 'var(--bg-tertiary)', borderRadius: 8 }}>
            <Form form={benefitForm} layout="inline" size="small">
              <Form.Item name="label" rules={[{ required: true, message: '请输入标签名' }]}>
                <Input placeholder="标签名称" style={{ width: 150 }} />
              </Form.Item>
              <Form.Item name="sort" initialValue={0}>
                <InputNumber placeholder="排序" min={0} style={{ width: 80 }} />
              </Form.Item>
              <Form.Item>
                <Space>
                  <Button type="primary" size="small" onClick={handleAddBenefit} loading={benefitLoading}>
                    确定
                  </Button>
                  <Button size="small" onClick={() => { setAddBenefitVisible(false); benefitForm.resetFields() }}>
                    取消
                  </Button>
                </Space>
              </Form.Item>
            </Form>
          </div>
        )}

        {benefitLoading ? (
          <div style={{ textAlign: 'center', padding: 40, color: '#999' }}>加载中...</div>
        ) : benefits.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 40, color: '#999' }}>暂无福利标签</div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {benefits.map((b) => (
              <Tag
                key={b.id}
                closable
                onClose={() => handleDeleteBenefit(b.id)}
                color="blue"
                style={{ padding: '4px 10px', fontSize: 13 }}
              >
                {b.label}
              </Tag>
            ))}
          </div>
        )}
      </Modal>

      {/* 时间配置弹窗 */}
      <Modal
        title="面试时间配置"
        open={showTimeConfig}
        onCancel={() => setShowTimeConfig(false)}
        onOk={handleSaveTimeConfig}
        okText="保存"
        cancelText="取消"
        confirmLoading={timeConfigLoading}
        width={500}
      >
        {timeConfigLoading ? (
          <div style={{ textAlign: 'center', padding: 40, color: '#999' }}>加载中...</div>
        ) : (
          <div className="time-config-groups">
            {timeGroups.map((group) => (
              <div key={group.type} className="time-config-group">
                <h4 style={{ margin: '12px 0 8px', color: 'var(--text-secondary)', fontSize: 13 }}>{group.label}</h4>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {group.times.map((t) => {
                    const isSelected = selectedTimes.includes(t.id)
                    return (
                      <Tag
                        key={t.id}
                        color={isSelected ? '#8B7355' : 'default'}
                        style={{ cursor: 'pointer', padding: '4px 12px', fontSize: 13 }}
                        onClick={() => {
                          setSelectedTimes((prev) =>
                            isSelected ? prev.filter((id) => id !== t.id) : [...prev, t.id]
                          )
                        }}
                      >
                        {t.label}
                      </Tag>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </Modal>

      {/* 地图选点弹窗 */}
      <Modal
        title="地图选点 - 点击地图获取经纬度"
        open={showMapPicker}
        onCancel={cancelMapPick}
        onOk={confirmMapPick}
        okText="确认选点"
        cancelText="取消"
        width={700}
        zIndex={1100}
        okButtonProps={{ disabled: pickedLng === null || pickedLat === null }}
      >
        <div style={{ marginBottom: 12, position: 'relative' }}>
          <Input
            placeholder="输入地点关键词搜索，如：三里屯"
            value={mapSearchText}
            onChange={(e) => handleMapInputChange(e.target.value)}
            onFocus={() => mapSearchText.trim() && suggestions.length === 0 && handleMapInputChange(mapSearchText)}
            allowClear
            onClear={() => setSuggestions([])}
          />
          {suggestions.length > 0 && (
            <div className="map-suggestion-list">
              {suggestions.map((item, idx) => (
                <div
                  key={idx}
                  className="map-suggestion-item"
                  onClick={() => handleSelectSuggestion(item)}
                >
                  <div className="suggestion-title">{item.title}</div>
                  <div className="suggestion-address">{item.province}{item.city}{item.district} {item.address}</div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div
          ref={mapRef}
          style={{
            width: '100%',
            height: 450,
            borderRadius: 8,
            border: '1px solid var(--border-color)',
            background: '#f5f5f5',
          }}
        />
        {pickedLng !== null && pickedLat !== null && (
          <div style={{ marginTop: 8, color: 'var(--text-secondary)', fontSize: 13 }}>
            已选坐标：经度 {pickedLng}，纬度 {pickedLat}
          </div>
        )}
      </Modal>
    </div>
  )
}

export default ShopListPage
