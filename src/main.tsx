import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import { ConfigProvider, message } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import App from './App'
import './styles/main.scss'

message.config({
  top: 52,
})

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
        components: {
          Table: {
            colorBgContainer: '#ffffff',
            headerBg: '#fafafa',
            fixedHeaderSortActiveBg: '#f0f0f0',
            rowHoverBg: '#f5f5f5',
          },
        },
      }}
    >
      <HashRouter>
        <App />
      </HashRouter>
    </ConfigProvider>
  </React.StrictMode>
)
