import './HomePage.scss'

function HomePage() {
  return (
    <div className="home-page">
      <div className="home-glow animate-breath"></div>
      <div className="home-content">
        <div className="brand-letters">
          {['w', 'e', 'f', 'l', 'o', 'w'].map((char, index) => (
            <span key={index} className="letter">
              <span className="letter-bg">{char}</span>
              <span className="letter-fill-wrapper" style={{ width: '100%' }}>
                <span className="letter-fill-content">{char}</span>
              </span>
            </span>
          ))}
        </div>
        <p className="home-subtitle">每一条消息的背后，都藏着一段温暖的时光</p>
      </div>
    </div>
  )
}

export default HomePage
