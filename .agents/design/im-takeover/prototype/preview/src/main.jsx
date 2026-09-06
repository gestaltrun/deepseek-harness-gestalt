import React from 'react'
import { createRoot } from 'react-dom/client'
import '../../system/tokens/base.css'
import '../../system/tokens/design-platform.css'
import '../../system/tokens/scrollbar.css'
import './app.css'
import { ImTakeover } from '../../drafts/im-takeover/index.jsx'
import { SamplePage } from './SamplePage.jsx'
import { BaselinePage } from './BaselinePage.jsx'

function App() {
  const [view, setView] = React.useState(() => new URLSearchParams(location.search).get('view') || 'im')
  React.useEffect(() => {
    const url = new URL(location.href)
    url.searchParams.set('view', view)
    history.replaceState(null, '', url)
  }, [view])
  if (view === 'sample') return <SamplePage onBack={() => setView('im')} />
  if (view === 'baseline') return <BaselinePage onBack={() => setView('im')} />
  return <ImTakeover onNavigate={setView} />
}

createRoot(document.getElementById('root')).render(<App />)
