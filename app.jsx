/* ROKI — clean meme-coin landing */
const { useState, useEffect, useRef } = React;

const PALETTE = {
  coral: '#E8534A', red: '#FF5959', yellow: '#FFDF3D',
  green: '#25E684', blue: '#2898E5', purple: '#9A4EDC',
  pink: '#FF5B94', orange: '#FFA73F', cream: '#F5EFE6'
};

// Crew gallery — each card uses an NFT image with its own bg color
const CREW = [
  { src: 'assets/c4.png',     name: 'GRAPPLER',        line: 'Locks you down.' },
  { src: 'assets/c1.png',     name: 'MIRROR',          line: 'Your style. Used back.' },
  { src: 'assets/c2.png',     name: 'TANK',            line: 'Won\u2019t fall.' },
  { src: 'assets/c3.png',     name: 'COUNTER PUNCHER', line: 'Waits. Strikes.' },
  { src: 'assets/visor.png',  name: 'KICKER',          line: 'Range is range.' },
  { src: 'assets/ninja.png',  name: 'BOXER',           line: 'Hands fast. No mercy.' },
];

const useReveal = () => {
  useEffect(() => {
    const els = document.querySelectorAll('.reveal');
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e, i) => {
        if (e.isIntersecting) {
          setTimeout(() => e.target.classList.add('in'), i * 40);
          io.unobserve(e.target);
        }
      });
    }, { threshold: 0.12 });
    els.forEach(el => io.observe(el));
    return () => io.disconnect();
  }, []);
};

const BrandMark = ({ size = 42 }) => (
  <span className="brand-mark" style={{ width: size, height: size }}>
    <img src="assets/logo.jpg" alt=""/>
  </span>
);

const Nav = () => (
  <nav className="nav">
    <a href="#home" className="nav-brand">
      <BrandMark size={42}/>
      <span className="brand-text">
        <div className="brand-name">ROKI</div>
      </span>
    </a>
    <ul className="nav-links">
      <li><a href="#home" className="active">Home</a></li>
      <li><a href="#about">About</a></li>
      <li><a href="docs/index.html#lock">Docs</a></li>
      <li><a href="#roadmap">Roadmap</a></li>
    </ul>
    <div className="nav-cta">
      <a href="https://x.com/rokitherabbit" target="_blank" rel="noopener noreferrer" className="btn btn-primary">
        <span className="btn-icon-bare"><img src="assets/logo-head.png" alt=""/></span>
        <span>Join Crew</span>
      </a>
    </div>
  </nav>
);

const Hero = ({ onMascotClick, mascotClicks }) => (
  <section className="hero" id="home">
    <div className="hero-text reveal">
      <h1 className="hero-title">
        ROK<span className="hero-i">
          <span className="hero-crown" aria-hidden="true">
            <svg viewBox="0 0 60 36" fill="#E8534A" stroke="#E8534A" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round">
              <path d="M4 32 L9 7 Q9 5 11 7 L21 21 Q22 23 23 21 L29 4 Q30 2 31 4 L37 21 Q38 23 39 21 L49 7 Q51 5 51 7 L56 32 Q56 34 54 33 Q30 35 6 33 Q4 34 4 32 Z"/>
            </svg>
          </span>
          I
        </span>
      </h1>
      <div className="hero-rule"/>
      <h2 className="hero-tagline">THE INTERNET'S NEW<br/>FAVORITE RABBIT.</h2>
      <p className="hero-body">
        ROKI is a meme coin with attitude.<br/>
        Backed by a movement, not by suits.<br/>
        We do it our way.
      </p>
      <div className="hero-ctas">
        <div className="cta-wrap">
          <a href="https://x.com/rokitherabbit" target="_blank" rel="noopener noreferrer" className="btn btn-primary">
            <span className="btn-icon-bare"><img src="assets/logo-head.png" alt=""/></span>
            <span>Join the Crew</span>
          </a>
        </div>
      </div>
    </div>
    <div className="hero-mascot bob reveal" onClick={onMascotClick} title={`(${mascotClicks}/5)`}>
      <img src="assets/satoshi.png" alt="ROKI"/>
    </div>
  </section>
);

const ICONS = {
  trend: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 17 9 11 13 15 21 7"/>
      <polyline points="14 7 21 7 21 14"/>
    </svg>
  ),
  community: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="9" r="3"/>
      <circle cx="17" cy="10" r="2.4"/>
      <path d="M3 19c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5"/>
      <path d="M14 19c0-2 1.4-3.5 3-3.5s3 1.5 3 3.5"/>
    </svg>
  ),
  bolt: (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z"/>
    </svg>
  )
};

const Features = () => (
  <section className="features stickers" id="about">
    <div className="sticker reveal">
      <span className="sticker-x sticker-x-tr">✕</span>
      <div className="sticker-title">MEME FIRST</div>
      <div className="sticker-desc">Loud. Louder.</div>
    </div>
    <div className="sticker reveal">
      <span className="sticker-x sticker-x-tr">✕</span>
      <div className="sticker-title">EARN IT</div>
      <div className="sticker-desc">No shortcuts.</div>
    </div>
    <div className="sticker sticker-hot reveal">
      <span className="sticker-crown" aria-hidden="true">
        <svg viewBox="0 0 26 18" fill="currentColor" stroke="currentColor" strokeWidth="0.5" strokeLinejoin="round"><path d="M2 16 L4 4 L9 10 L13 2 L17 10 L22 4 L24 16 Z"/></svg>
      </span>
      <span className="sticker-x sticker-x-tr">✕</span>
      <div className="sticker-title">GRIND DAILY</div>
      <div className="sticker-desc">Reps over hype.</div>
    </div>
    <div className="sticker reveal">
      <span className="sticker-x sticker-x-tr">✕</span>
      <div className="sticker-title">NEVER QUIT</div>
      <div className="sticker-desc">Eyes forward.</div>
    </div>
    <div className="sticker reveal">
      <span className="sticker-x sticker-x-tr">✕</span>
      <div className="sticker-title">STAY HUNGRY</div>
      <div className="sticker-desc">Never settle.</div>
    </div>
    <div className="built-different reveal" aria-hidden="true">
      <span className="bd-x">✕</span>
      <span className="bd-text">BUILT DIFFERENT.</span>
      <span className="bd-x">✕</span>
    </div>
  </section>
);

const Crew = () => (
  <section className="crew-section" id="crew">
    <div className="section-head reveal">
      <div className="section-title">PICK YOUR FIGHTER</div>
      <a href="#" className="section-link">VIEW ALL <span>›</span></a>
    </div>
    <div className="crew-grid">
      {CREW.map((c) => (
        <div key={c.name} className="crew-card reveal">
          <div className="crew-img">
            <img src={c.src} alt={c.name}/>
          </div>
          <div className="crew-meta">
            <div className="crew-name">{c.name}</div>
            <div className="crew-line">{c.line}</div>
          </div>
        </div>
      ))}
    </div>
  </section>
);

const Roadmap = ({ secretRevealed }) => (
  <section className="roadmap-section" id="roadmap">
    <div className="roadmap reveal">
      <div className="roadmap-title">ROADMAP</div>
      <div className="roadmap-grid">
        <div className="phase">
          <div className="phase-head">
            <div className="phase-num">1</div>
            <div className="phase-title">PHASE 1 — FORM THE CREW</div>
          </div>
          <ul className="phase-list">
            <li><span className="phase-check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>Establish the core community</li>
            <li><span className="phase-check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>Drop the NFT collection</li>
            <li><span className="phase-check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>Forge the original crew</li>
            <li><span className="phase-check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>Provide tools for creators</li>
            <li><span className="phase-check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>Spread the movement</li>
            <li><span className="phase-check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>Organic growth, no shortcuts</li>
          </ul>
        </div>
        <div className="phase phase-locked">
          <div className="classified-stamp" aria-hidden="true">CLASSIFIED</div>
          <div className="phase-head">
            <div className="phase-num">2</div>
            <div className="phase-title">PHASE 2 — {secretRevealed ? 'STREETS REMEMBER' : '[ REDACTED ]'}</div>
          </div>
          <div className="phase2-doc">
            <div className="doc-header">
              <div className="doc-mugshot" aria-hidden="true">
                <img src="assets/logo-head.png" alt=""/>
                <div className="doc-mugshot-bar"></div>
              </div>
              <div className="doc-header-meta">
                <div className="doc-header-row"><span>FILE NO.</span><b>002 / ROKI</b></div>
                <div className="doc-header-row"><span>STATUS</span><b className="status-sealed">SEALED</b></div>
                <div className="doc-header-row"><span>SUBJECT</span><b>UNKNOWN</b></div>
              </div>
            </div>
            <div className="doc-row"><span className="doc-label">OBJECTIVE</span><span className="redact-bar" style={{width: '78%'}}/></div>
            <div className="doc-row"><span className="doc-label">TIMELINE</span><span className="redact-bar" style={{width: '52%'}}/></div>
            <div className="doc-row"><span className="doc-label">ASSETS</span><span className="redact-bar" style={{width: '88%'}}/></div>
            <div className="doc-row"><span className="doc-label">OPERATION</span><span className="redact-bar" style={{width: '64%'}}/></div>
            <div className="doc-row"><span className="doc-label">PARTIES</span><span className="redact-bar" style={{width: '92%'}}/></div>
            <div className="doc-row"><span className="doc-label">ETA</span><span className="redact-bar" style={{width: '40%'}}/></div>
          </div>
          <div className="phase2-callout">
            <div className="phase2-callout-title"><span className="phase2-slash">/</span> Trust the process.</div>
            <div className="phase2-callout-sub">The next chapter reveals itself when the time is right.</div>
          </div>
        </div>
      </div>
    </div>
  </section>
);

const X_ICON = (
  <svg viewBox="0 0 24 24"><path fill="currentColor" d="M18.244 2H21l-6.522 7.45L22 22h-6.077l-4.76-6.22L5.6 22H2.842l6.97-7.97L2 2h6.231l4.3 5.682L18.244 2Z"/></svg>
);
const TG_ICON = (
  <svg viewBox="0 0 24 24"><path fill="currentColor" d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z"/></svg>
);
const TT_ICON = (
  <svg viewBox="0 0 24 24"><path fill="currentColor" d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5.8 20.1a6.34 6.34 0 0 0 10.86-4.43V8.42a8.16 8.16 0 0 0 4.77 1.52v-3.4a4.85 4.85 0 0 1-1.84-.18Z"/></svg>
);
const IG_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="0.7" fill="currentColor"/></svg>
);

const SectionRule = () => (
  <div className="section-rule reveal" aria-hidden="true">
    <span/>
  </div>
);

const Footer = () => (
  <footer className="footer">
    <div className="footer-brand">
      <span className="brand-mark"><img src="assets/logo.jpg" alt=""/></span>
      <div className="brand-text">
        <div className="brand-name">ROKI</div>
        <div className="brand-sub">THE INTERNET'S NEW FAVORITE RABBIT.</div>
      </div>
    </div>
    <div>
      <div className="footer-col-title">JOIN THE MOVEMENT</div>
      <div className="footer-socials">
        <a href="https://x.com/rokitherabbit" target="_blank" rel="noopener noreferrer" aria-label="X">{X_ICON}</a>
        <a href="https://www.tiktok.com/@roki_the_rabbit" target="_blank" rel="noopener noreferrer" aria-label="TikTok">{TT_ICON}</a>
        <a href="https://www.instagram.com/rokitherabbit" target="_blank" rel="noopener noreferrer" aria-label="Instagram">{IG_ICON}</a>
      </div>
    </div>
    <div>
      <div className="footer-col-title">LEGAL</div>
      <div className="footer-col-content">
        <a href="#">Privacy Policy</a>
        <a href="#">Terms of Use</a>
      </div>
    </div>
  </footer>
);

const App = () => {
  const [mascotClicks, setMascotClicks] = useState(0);
  const [secretRevealed, setSecretRevealed] = useState(false);
  useReveal();

  const onMascotClick = () => {
    const next = mascotClicks + 1;
    setMascotClicks(next);
    if (next >= 5 && !secretRevealed) {
      setSecretRevealed(true);
      document.body.classList.add('shake');
      setTimeout(() => document.body.classList.remove('shake'), 500);
      const colors = [PALETTE.coral, PALETTE.yellow, PALETTE.purple, PALETTE.green, PALETTE.pink, PALETTE.blue];
      for (let i = 0; i < 40; i++) {
        const c = document.createElement('div');
        c.className = 'confetti-bit';
        c.style.left = (Math.random() * 100) + 'vw';
        c.style.animationDelay = (Math.random() * 0.4) + 's';
        const w = 7 + Math.random() * 12;
        c.style.width = w + 'px';
        c.style.height = (w * (0.5 + Math.random()*0.6)) + 'px';
        c.style.background = colors[Math.floor(Math.random()*colors.length)];
        document.body.appendChild(c);
        setTimeout(() => c.remove(), 3000);
      }
      console.log('// access granted // welcome to the streets');
    }
  };

  return (
    <div className="page">
      <Nav/>
      <Hero onMascotClick={onMascotClick} mascotClicks={mascotClicks}/>
      <Features/>
      <SectionRule/>
      <Crew/>
      <SectionRule/>
      <Roadmap secretRevealed={secretRevealed}/>
      <Footer/>
    </div>
  );
};

ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
