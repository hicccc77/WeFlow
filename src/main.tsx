import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import App from './App'
import './styles/main.scss'

ReactDOM.createRoot(document.getElementById('app')!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: '#8B7355',
          borderRadius: 8,
          colorBgContainer: 'rgba(255, 255, 255, 0.7)',
          colorBgLayout: '#F0EEE9',
          colorText: '#3d3d3d',
          colorTextSecondary: '#666666',
          colorBorder: 'rgba(0, 0, 0, 0.08)',
        },
      }}
    >
      <HashRouter>
        <App />
      </HashRouter>
    </ConfigProvider>
  </React.StrictMode>
)
