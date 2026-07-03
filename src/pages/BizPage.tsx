import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useThemeStore } from '../stores/themeStore';
import { AlertTriangle, Clock, MessageSquareOff, Newspaper } from 'lucide-react';
import './BizPage.scss';

export interface BizAccount {
  username: string;
  name: string;
  avatar: string;
  type: number | string;
  last_time: number;
  formatted_last_time: string;
  unread_count?: number;
  status?: 'active' | 'inactive';
  health_reason?: string;
  stale_level?: 'none' | 'one_year' | 'two_year' | 'unknown';
  days_since_last_article?: number;
}

interface BizAccountHealth {
  summary: {
    active_total: number;
    subscription_total: number;
    service_total: number;
    invalid_total: number;
    stale_one_year_total: number;
    stale_two_year_total: number;
    unknown_last_article_total: number;
  };
  accounts: BizAccount[];
  invalid_accounts: BizAccount[];
}

type BizFilter = 'active' | 'invalid' | 'one_year' | 'two_year' | 'unknown';

export const BizAccountList: React.FC<{
  onSelect: (account: BizAccount) => void;
  selectedUsername?: string;
  searchKeyword?: string;
}> = ({ onSelect, selectedUsername, searchKeyword }) => {
  const [accounts, setAccounts] = useState<BizAccount[]>([]);
  const [health, setHealth] = useState<BizAccountHealth | null>(null);
  const [filter, setFilter] = useState<BizFilter>('active');
  const [loading, setLoading] = useState(false);

  const [myWxid, setMyWxid] = useState<string>('');

  useEffect(() => {
    const initWxid = async () => {
      try {
        const wxid = await window.electronAPI.config.get('myWxid');
        if (wxid) {
          setMyWxid(wxid as string);
        }
      } catch (e) {
        console.error("获取 myWxid 失败:", e);
      }
    };
    initWxid().then(_r => { });
  }, []);

  const fetchAccounts = useCallback(async () => {
    if (!myWxid) {
      return;
    }

    setLoading(true);
    try {
      if (window.electronAPI.biz.listAccountHealth) {
        const res = await window.electronAPI.biz.listAccountHealth(myWxid) as BizAccountHealth;
        setHealth(res || null);
        setAccounts([...(res?.accounts || []), ...(res?.invalid_accounts || [])]);
      } else {
        const res = await window.electronAPI.biz.listAccounts(myWxid)
        setHealth(null);
        setAccounts(res || []);
      }
    } catch (err) {
      console.error('获取服务号列表失败:', err);
    } finally {
      setLoading(false);
    }
  }, [myWxid]);

  useEffect(() => {
    fetchAccounts().then(_r => { });
  }, [fetchAccounts]);

  useEffect(() => {
    if (!window.electronAPI.chat.onWcdbChange) return;
    const removeListener = window.electronAPI.chat.onWcdbChange((_event: any, data: { json?: string }) => {
      try {
        const payload = JSON.parse(data.json || '{}');
        const tableName = String(payload.table || '').toLowerCase();
        if (!tableName || tableName === 'session' || tableName.includes('message') || tableName.startsWith('msg_')) {
          fetchAccounts().then(_r => { });
        }
      } catch {
        fetchAccounts().then(_r => { });
      }
    });
    return () => removeListener();
  }, [fetchAccounts]);


  const filtered = useMemo(() => {
    let result = accounts;
    if (health) {
      if (filter === 'active') result = health.accounts || [];
      else if (filter === 'invalid') result = health.invalid_accounts || [];
      else result = (health.accounts || []).filter(a => a.stale_level === filter || (filter === 'one_year' && a.stale_level === 'two_year'));
    }
    if (searchKeyword) {
      const q = searchKeyword.toLowerCase();
      result = result.filter(a =>
          (a.name && a.name.toLowerCase().includes(q)) ||
          (a.username && a.username.toLowerCase().includes(q))
      );
    }
    return result.sort((a, b) => {
      if (a.username === 'gh_3dfda90e39d6') return -1; // 微信支付置顶
      if (b.username === 'gh_3dfda90e39d6') return 1;
      return b.last_time - a.last_time;
    });
  }, [accounts, filter, health, searchKeyword]);

  const renderFilterButton = (nextFilter: BizFilter, label: string, count: number) => (
    <button
      type="button"
      className={`biz-health-filter ${filter === nextFilter ? 'active' : ''}`}
      onClick={() => setFilter(nextFilter)}
    >
      <span>{label}</span>
      <strong>{count}</strong>
    </button>
  );

  if (loading) return <div className="biz-loading">加载中...</div>;

  return (
      <div className="biz-account-list">
        {health && (
          <div className="biz-health-panel">
            <div className="biz-health-row">
              {renderFilterButton('active', '有效', health.summary.active_total)}
              {renderFilterButton('invalid', '疑似失效', health.summary.invalid_total)}
            </div>
            <div className="biz-health-row">
              {renderFilterButton('one_year', '1年未发', health.summary.stale_one_year_total)}
              {renderFilterButton('two_year', '2年未发', health.summary.stale_two_year_total)}
            </div>
            <div className="biz-health-counts">
              <span>公众号 {health.summary.subscription_total}</span>
              <span>服务号 {health.summary.service_total}</span>
              <span>无记录 {health.summary.unknown_last_article_total}</span>
            </div>
          </div>
        )}
        {filtered.map(item => (
            <div
                key={item.username}
                onClick={() => {
                  setAccounts(prev => prev.map(account =>
                    account.username === item.username ? { ...account, unread_count: 0 } : account
                  ));
                  onSelect({ ...item, unread_count: 0 });
                }}
                className={`biz-account-item ${selectedUsername === item.username ? 'active' : ''} ${item.username === 'gh_3dfda90e39d6' ? 'pay-account' : ''}`}
            >
              <img
                  src={item.avatar}
                  className="biz-avatar"
                  alt=""
              />
              {(item.unread_count || 0) > 0 && (
                  <span className="biz-unread-badge">{(item.unread_count || 0) > 99 ? '99+' : item.unread_count}</span>
              )}
              <div className="biz-info">
                <div className="biz-info-top">
                  <span className="biz-name">{item.name || item.username}</span>
                  <span className="biz-time">{item.formatted_last_time}</span>
                </div>
                {/*{item.username === 'gh_3dfda90e39d6' && (*/}
                {/*    <div className="biz-badge type-service">微信支付</div>*/}
                {/*)}*/}

                <div className="biz-badge-row">
                {(() => {
                  const typeValue = Number(item.type);
                  return (
                    <div className={`biz-badge ${
                        typeValue === 1 ? 'type-service' :
                            typeValue === 0 ? 'type-sub' :
                                typeValue === 2 ? 'type-enterprise' :
                                    typeValue === 3 ? 'type-enterprise' : 'type-unknown'
                    }`}>
                      {typeValue === 0 ? '公众号' : typeValue === 1 ? '服务号' : typeValue === 2 ? '企业号' : typeValue === 3 ? '企业附属' :  '未知'}
                    </div>
                  );
                })()}
                {item.status === 'inactive' && (
                  <div className="biz-badge type-invalid"><AlertTriangle size={11} />疑似失效</div>
                )}
                {item.status !== 'inactive' && item.stale_level === 'one_year' && (
                  <div className="biz-badge type-stale"><Clock size={11} />1年未发</div>
                )}
                {item.status !== 'inactive' && item.stale_level === 'two_year' && (
                  <div className="biz-badge type-stale"><Clock size={11} />2年未发</div>
                )}
                {item.status !== 'inactive' && item.stale_level === 'unknown' && (
                  <div className="biz-badge type-unknown"><Clock size={11} />无记录</div>
                )}
                </div>

              </div>
            </div>
        ))}
      </div>
  );
};

export const BizMessageArea: React.FC<{
  account: BizAccount | null;
}> = ({ account }) => {
  const themeMode = useThemeStore((state) => state.themeMode);
  const [messages, setMessages] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const limit = 20;
  const messageListRef = useRef<HTMLDivElement>(null);
  const lastScrollHeightRef = useRef<number>(0);
  const isInitialLoadRef = useRef<boolean>(true);

  const [myWxid, setMyWxid] = useState<string>('');

  useEffect(() => {
    const initWxid = async () => {
      try {
        const wxid = await window.electronAPI.config.get('myWxid');
        if (wxid) {
          setMyWxid(wxid as string);
        }
      } catch (e) { }
    };
    initWxid();
  }, []);

  const isDark = useMemo(() => {
    if (themeMode === 'dark') return true;
    if (themeMode === 'system') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    return false;
  }, [themeMode]);

  useEffect(() => {
    if (account && myWxid) {
      setMessages([]);
      setOffset(0);
      setHasMore(true);
      isInitialLoadRef.current = true;
      loadMessages(account.username, 0);
    }
  }, [account, myWxid]);

  const loadMessages = async (username: string, currentOffset: number) => {
    if (loading || !myWxid) return;

    setLoading(true);
    if (messageListRef.current) {
      lastScrollHeightRef.current = messageListRef.current.scrollHeight;
    }

    try {
      let res;
      if (username === 'gh_3dfda90e39d6') {
        res = await window.electronAPI.biz.listPayRecords(myWxid, limit, currentOffset);
      } else {
        res = await window.electronAPI.biz.listMessages(username, myWxid, limit, currentOffset);
      }

      if (res) {
        if (res.length < limit) setHasMore(false);

        setMessages(prev => {
          const combined = currentOffset === 0 ? res : [...res, ...prev];
          const uniqueMessages = Array.from(new Map(combined.map(item => [item.local_id || item.create_time, item])).values());
          return uniqueMessages.sort((a, b) => a.create_time - b.create_time);
        });
        setOffset(currentOffset + limit);
      }
    } catch (err) {
      console.error('加载消息失败:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!messageListRef.current) return;

    if (isInitialLoadRef.current && messages.length > 0) {
      messageListRef.current.scrollTop = messageListRef.current.scrollHeight;
      isInitialLoadRef.current = false;
    } else if (messages.length > 0 && !isInitialLoadRef.current && !loading) {

      const newScrollHeight = messageListRef.current.scrollHeight;
      const heightDiff = newScrollHeight - lastScrollHeightRef.current;
      if (heightDiff > 0 && messageListRef.current.scrollTop < 100) {
        messageListRef.current.scrollTop += heightDiff;
      }
    }
  }, [messages, loading]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    // 向上滚动到顶部附近触发加载更多（更旧的消息）
    if (target.scrollTop < 50) {
      if (!loading && hasMore && account) {
        loadMessages(account.username, offset);
      }
    }
  };

  if (!account) {
    return (
        <div className="biz-empty-state">
          <div className="empty-icon"><Newspaper size={40} /></div>
          <p>请选择一个服务号查看消息</p>
        </div>
    );
  }

  const formatMessageTime = (timestamp: number) => {
    if (!timestamp) return '';
    const date = new Date(timestamp * 1000);
    const now = new Date();
    
    const isToday = date.toDateString() === now.toDateString();
    if (isToday) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    }
    
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) {
      return `昨天 ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
    }

    const isThisYear = date.getFullYear() === now.getFullYear();
    if (isThisYear) {
      return `${date.getMonth() + 1}月${date.getDate()}日 ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
    }
    
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
  };

  const defaultImage = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MDAiIGhlaWdodD0iMTgwIj48cmVjdCB3aWR0aD0iNDAwIiBoZWlnaHQ9IjE4MCIgZmlsbD0iI2Y1ZjVmNSIvPjwvc3ZnPg==';

  return (
      <div className={`biz-main ${isDark ? 'dark' : ''}`}>
        <div className="main-header">
          <h2>{account.name}</h2>
        </div>
        <div className="message-container" onScroll={handleScroll} ref={messageListRef}>
          <div className="messages-wrapper">
            {hasMore && messages.length > 0 && (
                <div className="biz-loading-more">{loading ? '加载中...' : '向上滚动加载更多历史消息'}</div>
            )}
            {!loading && messages.length === 0 && (
              <div className="biz-no-record-container">
                <div className="no-record-icon">
                  <MessageSquareOff size={48} />
                </div>
                <h3>暂无本地记录</h3>
                <p>该公众号在当前数据库中没有可显示的聊天历史</p>
              </div>
            )}
            {messages.map((msg, index) => {
                const showTime = true;
                
                return (
                    <div key={msg.local_id || index}>
                      {showTime && (
                          <div className="time-divider">
                            <span>{formatMessageTime(msg.create_time)}</span>
                          </div>
                      )}
                      
                      {account.username === 'gh_3dfda90e39d6' ? (
                          <div className="pay-card">
                            <div className="pay-header">
                              {msg.merchant_icon ? <img src={msg.merchant_icon} className="pay-icon" alt=""/> : <div className="pay-icon-placeholder">¥</div>}
                              <span>{msg.merchant_name || '微信支付'}</span>
                            </div>
                            <div className="pay-title">{msg.title}</div>
                            <div className="pay-desc">{msg.description}</div>
                            {/* <div className="pay-footer">{msg.formatted_time}</div> */}
                          </div>
                      ) : (
                          <div className="article-card">
                            <div onClick={() => window.electronAPI.shell.openExternal(msg.url)} className="main-article">
                              <img src={msg.cover || defaultImage} className="article-cover" alt=""/>
                              <div className="article-overlay"><h3 className="article-title">{msg.title}</h3></div>
                            </div>
                            {msg.des && <div className="article-digest">{msg.des}</div>}
                            {msg.content_list && msg.content_list.length > 1 && (
                                <div className="sub-articles">
                                  {msg.content_list.slice(1).map((item: any, idx: number) => (
                                      <div key={idx} onClick={() => window.electronAPI.shell.openExternal(item.url)} className="sub-item">
                                        <span className="sub-title">{item.title}</span>
                                        {item.cover && <img src={item.cover} className="sub-cover" alt=""/>}
                                      </div>
                                  ))}
                                </div>
                            )}
                          </div>
                      )}
                    </div>
                );
            })}
            {loading && offset === 0 && <div className="biz-loading-more">加载中...</div>}
          </div>
        </div>
      </div>
  );
};

const BizPage: React.FC = () => {
  const [selectedAccount, setSelectedAccount] = useState<BizAccount | null>(null);
  return (
      <div className="biz-page">
        <div className="biz-sidebar">
          <BizAccountList onSelect={setSelectedAccount} selectedUsername={selectedAccount?.username} />
        </div>
        <BizMessageArea account={selectedAccount} />
      </div>
  );
}

export default BizPage;
