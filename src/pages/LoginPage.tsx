import { useState } from 'react'
import { Button, Input, Form, message, Typography, Space } from 'antd'
import { UserOutlined, LockOutlined, LoginOutlined, PoweroffOutlined } from '@ant-design/icons'
import { useAppStore } from '../stores/appStore'

const HARDCODED_USERNAME = 'admin'
const HARDCODED_PASSWORD = 'admin123'

export default function LoginPage() {
  const setIsLoggedIn = useAppStore(state => state.setIsLoggedIn)
  const [isLogging, setIsLogging] = useState(false)
  const [isSuccess, setIsSuccess] = useState(false)

  const handleSubmit = (values: { username: string; password: string }) => {
    setIsLogging(true)

    setTimeout(() => {
      if (values.username === HARDCODED_USERNAME && values.password === HARDCODED_PASSWORD) {
        setIsSuccess(true)
        setTimeout(() => {
          setIsLoggedIn(true)
        }, 600)
      } else {
        message.error('账号或密码错误')
        setIsLogging(false)
      }
    }, 300)
  }

  const handleQuit = () => {
    try {
      window.electronAPI.window.respondCloseConfirm('quit')
    } catch {
      window.close()
    }
  }

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      width: '100vw',
      height: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%)',
      zIndex: 9999,
      WebkitAppRegion: 'drag' as any,
      opacity: isSuccess ? 0 : 1,
      transition: 'opacity 0.5s ease',
    }}>
      <div style={{
        width: 380,
        padding: '48px 40px 40px',
        background: '#fff',
        borderRadius: 12,
        boxShadow: '0 8px 40px rgba(0, 0, 0, 0.12)',
        WebkitAppRegion: 'no-drag' as any,
        animation: 'loginCardFadeIn 0.5s ease',
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: 32 }}>
          <img
            src="https://www.quikms.com/favicon.ico"
            alt="Logo"
            style={{
              width: 64,
              height: 64,
              borderRadius: 14,
              marginBottom: 20,
              boxShadow: '0 4px 16px rgba(0, 0, 0, 0.08)',
            }}
          />
          <Typography.Title level={4} style={{ margin: 0, fontWeight: 600 }}>
            浅雨科技人力仓管理系统
          </Typography.Title>
          <Typography.Text type="secondary" style={{ marginTop: 8 }}>
            请输入账号密码以继续
          </Typography.Text>
        </div>

        <Form
          onFinish={handleSubmit}
          size="large"
          autoComplete="off"
        >
          <Form.Item
            name="username"
            rules={[{ required: true, message: '请输入账号' }]}
          >
            <Input
              prefix={<UserOutlined style={{ color: '#bfbfbf' }} />}
              placeholder="请输入账号"
              disabled={isLogging}
              autoFocus
            />
          </Form.Item>

          <Form.Item
            name="password"
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input.Password
              prefix={<LockOutlined style={{ color: '#bfbfbf' }} />}
              placeholder="请输入密码"
              disabled={isLogging}
            />
          </Form.Item>

          <Form.Item style={{ marginBottom: 12 }}>
            <Space direction="vertical" style={{ width: '100%' }} size={12}>
              <Button
                type="primary"
                htmlType="submit"
                block
                loading={isLogging}
                icon={<LoginOutlined />}
                style={{ height: 44, borderRadius: 8, fontWeight: 500 }}
              >
                登录
              </Button>
              <Button
                block
                danger
                icon={<PoweroffOutlined />}
                onClick={handleQuit}
                style={{ height: 44, borderRadius: 8, fontWeight: 500 }}
              >
                退出软件
              </Button>
            </Space>
          </Form.Item>
        </Form>
      </div>

      <style>{`
        @keyframes loginCardFadeIn {
          from { opacity: 0; transform: translateY(20px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  )
}
