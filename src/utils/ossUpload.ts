const API_BASE = 'https://store.quikms.com'

interface OssSignatureResponse {
  errno: number
  errmsg: string
  data: {
    accessKeyId: string
    policy: string
    signature: string
    host: string
    dir: string
    expire: number
  }
}

async function getOssSignature(type: 'company' | 'shop'): Promise<OssSignatureResponse['data']> {
  const res = await fetch(`${API_BASE}/admin/auth/getOssSignature?type=${type}`)
  const json: OssSignatureResponse = await res.json()
  if (json.errno !== 0) {
    throw new Error(json.errmsg || '获取 OSS 签名失败')
  }
  return json.data
}

/**
 * 通过服务端签名上传图片到阿里云 OSS
 * @param file 要上传的文件
 * @param type 上传类型：company（企业）或 shop（门店）
 * @returns 上传后的完整 URL
 */
export async function uploadImageToOss(file: File, type: 'company' | 'shop'): Promise<string> {
  const signature = await getOssSignature(type)

  const formData = new FormData()
  formData.append('key', signature.dir)
  formData.append('OSSAccessKeyId', signature.accessKeyId)
  formData.append('policy', signature.policy)
  formData.append('signature', signature.signature)
  formData.append('success_action_status', '200')
  formData.append('file', file)

  const res = await fetch(signature.host, {
    method: 'POST',
    body: formData,
  })

  if (!res.ok) {
    throw new Error(`上传失败，状态码：${res.status}`)
  }

  return `${signature.host}/${signature.dir}`
}
