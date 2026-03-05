import { useEffect, useRef, useState } from 'react'
import { Link, Navigate, NavLink, Route, Routes } from 'react-router-dom'
import { io } from 'socket.io-client'
import html2canvas from 'html2canvas'
import jsQR from 'jsqr'
import { api, getApiError } from './services/api'
import './App.css'

const SCORING_MODEL = {
  easy: 5,
  medium: 10,
  hard: 15,
  speedBonusPoints: 2,
  speedBonusMaxMs: 15000,
}

const ROOM_CODE_PATTERN = /^[A-Z0-9]{4,12}$/
const QR_PAYLOAD_PATTERN = /^[A-Z0-9:_-]{3,120}$/
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function createBlankQuestionForm() {
  return {
    prompt: '',
    difficulty: 'easy',
    explanation: '',
    options: [
      { optionText: '', isCorrect: true },
      { optionText: '', isCorrect: false },
      { optionText: '', isCorrect: false },
      { optionText: '', isCorrect: false },
    ],
  }
}

function validateAuthForm(authMode, form) {
  const email = String(form.email || '').trim()
  const password = String(form.password || '')
  const displayName = String(form.displayName || '').trim()

  if (!EMAIL_PATTERN.test(email)) return 'Enter a valid email address'
  if (password.length < 6) return 'Password must be at least 6 characters'
  if (authMode === 'register' && displayName.length < 2) return 'Display name must be at least 2 characters'
  return ''
}

function validateQuestionFormInput(form) {
  if (String(form.prompt || '').trim().length < 5) return 'Question prompt must be at least 5 characters'

  const options = Array.isArray(form.options) ? form.options : []
  if (options.length < 2) return 'Question must have at least 2 options'
  if (options.some((option) => String(option.optionText || '').trim().length === 0)) {
    return 'Every option must have text'
  }
  const correctCount = options.filter((option) => option.isCorrect).length
  if (correctCount !== 1) return 'Select exactly one correct option'
  return ''
}

function App() {
  const [health, setHealth] = useState({ status: 'checking', detail: '' })
  const [authMode, setAuthMode] = useState('login')
  const [authForm, setAuthForm] = useState({
    email: '',
    password: '',
    displayName: '',
  })
  const [user, setUser] = useState(null)
  const [authBusy, setAuthBusy] = useState(false)
  const [authMessage, setAuthMessage] = useState('')

  const [roomCodeInput, setRoomCodeInput] = useState('')
  const [roomState, setRoomState] = useState(null)
  const [roomBusy, setRoomBusy] = useState(false)
  const [roomMessage, setRoomMessage] = useState('')

  const [scanPayload, setScanPayload] = useState('FQ-TILE-01')
  const [scanBusy, setScanBusy] = useState(false)
  const [scanMessage, setScanMessage] = useState('')
  const [activePrompt, setActivePrompt] = useState(null)
  const [selectedOptionId, setSelectedOptionId] = useState('')
  const [attemptResult, setAttemptResult] = useState(null)

  const [boardTiles, setBoardTiles] = useState([])
  const [boardQrPreview, setBoardQrPreview] = useState(null)
  const [boardBusy, setBoardBusy] = useState(false)
  const [boardPrintSheet, setBoardPrintSheet] = useState(null)
  const [boardPrintBusy, setBoardPrintBusy] = useState(false)
  const [boardPrintMessage, setBoardPrintMessage] = useState('')
  const [boardAdminBusy, setBoardAdminBusy] = useState(false)
  const [boardAdminMessage, setBoardAdminMessage] = useState('')

  const [questions, setQuestions] = useState([])
  const [questionsBusy, setQuestionsBusy] = useState(false)
  const [questionsMessage, setQuestionsMessage] = useState('')
  const [editingQuestionId, setEditingQuestionId] = useState(null)
  const [questionForm, setQuestionForm] = useState(createBlankQuestionForm)

  const [socketStatus, setSocketStatus] = useState('disconnected')
  const [liveFeed, setLiveFeed] = useState([])

  const [roomHistory, setRoomHistory] = useState([])
  const [historyBusy, setHistoryBusy] = useState(false)
  const [historyMessage, setHistoryMessage] = useState('')

  const socketRef = useRef(null)
  const userRef = useRef(null)
  const roomCodeRef = useRef('')
  const questionStartTimeRef = useRef(null)

  const scoreboard = roomState?.players ?? []
  const currentRoomCode = roomState?.room?.roomCode ?? ''

  useEffect(() => {
    userRef.current = user
  }, [user])

  useEffect(() => {
    roomCodeRef.current = currentRoomCode
  }, [currentRoomCode])

  useEffect(() => {
    loadHealth()
    loadSession()
  }, [])

  useEffect(() => {
    const socketUrl = import.meta.env.VITE_SOCKET_URL || undefined
    const socket = io(socketUrl, {
      withCredentials: true,
      autoConnect: true,
    })

    socketRef.current = socket

    socket.on('connect', () => setSocketStatus('connected'))
    socket.on('disconnect', () => setSocketStatus('disconnected'))

    socket.on('room:state', (payload) => {
      if (payload?.room?.roomCode === roomCodeRef.current) {
        setRoomState(payload)
      }
    })

    socket.on('scoreboard:update', (payload) => {
      if (payload?.roomCode !== roomCodeRef.current) return
      setRoomState((prev) => (prev ? { ...prev, players: payload.players ?? prev.players } : prev))
    })

    socket.on('attempt:result', (payload) => {
      if (payload?.roomCode !== roomCodeRef.current) return

      const actor = payload.userId === userRef.current?.id ? 'You' : 'A player'
      setLiveFeed((prev) =>
        [
          {
            id: `${Date.now()}-${Math.random()}`,
            text: `${actor} ${payload.isCorrect ? 'answered correctly' : 'answered incorrectly'} (${payload.awardedPoints} pts)${
              payload.nextTurnDisplayName ? ` • Next: ${payload.nextTurnDisplayName}` : ''
            }${payload.bonusPoints ? ` • +${payload.bonusPoints} speed bonus` : ''}`,
            time: new Date().toLocaleTimeString(),
          },
          ...prev,
        ].slice(0, 10),
      )
    })

    return () => {
      socket.disconnect()
      socketRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!user) {
      setRoomState(null)
      setBoardTiles([])
      setBoardQrPreview(null)
      setBoardPrintSheet(null)
      setBoardPrintMessage('')
      setBoardAdminMessage('')
      setQuestions([])
      setRoomHistory([])
      setEditingQuestionId(null)
      setQuestionForm(createBlankQuestionForm())
      return
    }

    loadBoardTiles()
    if (user.role === 'admin') {
      loadQuestions()
    }
  }, [user])

  useEffect(() => {
    const socket = socketRef.current
    if (!socket || !currentRoomCode) return undefined

    socket.emit('room:join', { roomCode: currentRoomCode })
    loadRoomHistory(currentRoomCode)

    return () => {
      socket.emit('room:leave', { roomCode: currentRoomCode })
    }
  }, [currentRoomCode])

  async function loadHealth() {
    try {
      const { data } = await api.get('/health')
      setHealth({ status: 'online', detail: data.serverTime })
    } catch (error) {
      setHealth({ status: 'offline', detail: getApiError(error) })
    }
  }

  async function loadSession() {
    try {
      const { data } = await api.get('/auth/me')
      setUser(data.user || null)
      if (data.user) {
        setAuthMessage(`Welcome back, ${data.user.displayName}`)
      }
    } catch (error) {
      if (error?.response?.status === 401) {
        setAuthMessage('')
        return
      }
      setAuthMessage(getApiError(error))
    }
  }

  async function handleAuthSubmit(event) {
    event.preventDefault()
    const validationMessage = validateAuthForm(authMode, authForm)
    if (validationMessage) {
      setAuthMessage(validationMessage)
      return
    }

    setAuthBusy(true)
    setAuthMessage('')

    try {
      const endpoint = authMode === 'login' ? '/auth/login' : '/auth/register'
      const payload =
        authMode === 'login'
          ? { email: authForm.email.trim(), password: authForm.password }
          : {
              email: authForm.email.trim(),
              password: authForm.password,
              displayName: authForm.displayName.trim(),
            }

      const { data } = await api.post(endpoint, payload)
      setUser(data.user)
      setAuthMessage(`${authMode === 'login' ? 'Logged in' : 'Registered'} as ${data.user.displayName}`)
    } catch (error) {
      setAuthMessage(getApiError(error))
    } finally {
      setAuthBusy(false)
    }
  }

  async function handleLogout() {
    try {
      await api.post('/auth/logout')
      setUser(null)
      setRoomState(null)
      setRoomCodeInput('')
      setActivePrompt(null)
      setSelectedOptionId('')
      setAttemptResult(null)
      setLiveFeed([])
      setRoomHistory([])
      setBoardPrintSheet(null)
      setBoardPrintMessage('')
      setBoardAdminMessage('')
      setEditingQuestionId(null)
      setQuestionForm(createBlankQuestionForm())
      setAuthMessage('Logged out')
      setRoomMessage('')
      setScanMessage('')
    } catch (error) {
      setAuthMessage(getApiError(error))
    }
  }

  async function createRoom() {
    setRoomBusy(true)
    setRoomMessage('')
    try {
      const { data } = await api.post('/rooms', {})
      setRoomState(data)
      setRoomCodeInput(data.room.roomCode)
      setRoomMessage(`Created room ${data.room.roomCode}`)
      await loadRoomHistory(data.room.roomCode)
    } catch (error) {
      setRoomMessage(getApiError(error))
    } finally {
      setRoomBusy(false)
    }
  }

  async function joinRoom() {
    const roomCode = roomCodeInput.trim().toUpperCase()
    if (!roomCode) {
      setRoomMessage('Enter a room code')
      return
    }
    if (!ROOM_CODE_PATTERN.test(roomCode)) {
      setRoomMessage('Room code must be 4-12 letters/numbers')
      return
    }

    setRoomBusy(true)
    setRoomMessage('')
    try {
      const { data } = await api.post(`/rooms/${roomCode}/join`, { roomCode })
      setRoomState(data)
      setRoomCodeInput(data.room.roomCode)
      setRoomMessage(`Joined room ${data.room.roomCode}`)
      await loadRoomHistory(data.room.roomCode)
    } catch (error) {
      setRoomMessage(getApiError(error))
    } finally {
      setRoomBusy(false)
    }
  }

  async function refreshRoom() {
    const roomCode = (currentRoomCode || roomCodeInput).trim().toUpperCase()
    if (!roomCode) return

    setRoomBusy(true)
    setRoomMessage('')
    try {
      const { data } = await api.get(`/rooms/${roomCode}`)
      setRoomState(data)
      setRoomCodeInput(data.room.roomCode)
      setRoomMessage(`Refreshed room ${data.room.roomCode}`)
      await loadRoomHistory(data.room.roomCode)
    } catch (error) {
      setRoomMessage(getApiError(error))
    } finally {
      setRoomBusy(false)
    }
  }

  async function startRoom() {
    if (!currentRoomCode) return
    if (!roomState || !user) return
    if (roomState.room.hostUserId !== user.id) {
      setRoomMessage('Only the host can start the room')
      return
    }

    setRoomBusy(true)
    setRoomMessage('')
    try {
      const { data } = await api.post(`/rooms/${currentRoomCode}/start`)
      setRoomState(data)
      setRoomMessage(`Room ${data.room.roomCode} started`)
      await loadRoomHistory(data.room.roomCode)
    } catch (error) {
      setRoomMessage(getApiError(error))
    } finally {
      setRoomBusy(false)
    }
  }

  async function finishRoom() {
    if (!currentRoomCode) return
    if (!roomState || !user) return
    if (roomState.room.hostUserId !== user.id) {
      setRoomMessage('Only the host can finish the room')
      return
    }
    if (!window.confirm('Finish this room? Players will no longer be able to answer questions.')) {
      return
    }

    setRoomBusy(true)
    setRoomMessage('')
    try {
      const { data } = await api.post(`/rooms/${currentRoomCode}/finish`)
      setRoomState(data)
      setRoomMessage(`Room ${data.room.roomCode} finished`)
      await loadRoomHistory(data.room.roomCode)
    } catch (error) {
      setRoomMessage(getApiError(error))
    } finally {
      setRoomBusy(false)
    }
  }

  async function copyRoomCode() {
    if (!currentRoomCode) return

    try {
      await navigator.clipboard.writeText(currentRoomCode)
      setRoomMessage(`Room code ${currentRoomCode} copied`)
    } catch {
      setRoomMessage('Copy failed on this browser')
    }
  }

  async function scanTile() {
    if (!currentRoomCode) {
      setScanMessage('Create or join a room first')
      return
    }

    const payload = scanPayload.trim().toUpperCase()
    if (!payload) {
      setScanMessage('Enter a QR payload')
      return
    }
    if (!QR_PAYLOAD_PATTERN.test(payload)) {
      setScanMessage('QR payload format is invalid')
      return
    }

    setScanBusy(true)
    setScanMessage('')
    setAttemptResult(null)
    setSelectedOptionId('')

    try {
      const { data } = await api.post(`/rooms/${currentRoomCode}/scan`, {
        qrPayload: payload,
      })
      setActivePrompt(data)
      questionStartTimeRef.current = Date.now()
      setScanMessage(`Loaded tile ${data.tileNumber}`)
    } catch (error) {
      setScanMessage(getApiError(error))
    } finally {
      setScanBusy(false)
    }
  }

  async function submitAnswer() {
    if (!currentRoomCode || !activePrompt?.question || !selectedOptionId) {
      setScanMessage('Select an answer first')
      return
    }

    const responseTimeMs = questionStartTimeRef.current
      ? Date.now() - questionStartTimeRef.current
      : undefined

    setScanBusy(true)
    setScanMessage('')
    try {
      const { data } = await api.post(`/rooms/${currentRoomCode}/attempts`, {
        questionId: activePrompt.question.id,
        selectedOptionId,
        responseTimeMs,
        currentTile: activePrompt.tileNumber,
      })

      setAttemptResult(data)
      setRoomState((prev) => (prev ? { ...prev, players: data.scoreboard ?? prev.players } : prev))
      if (data.roomAutoFinished || data.roomStatus === 'finished') {
        setScanMessage(
          `${data.isCorrect ? 'Correct answer' : 'Incorrect answer'} • All players completed all questions. The game is now finished.`,
        )
      } else {
        setScanMessage(data.isCorrect ? 'Correct answer' : 'Incorrect answer')
      }
      await loadRoomHistory(currentRoomCode)
    } catch (error) {
      setScanMessage(getApiError(error))
    } finally {
      setScanBusy(false)
    }
  }

  async function loadBoardTiles() {
    if (!user) return

    setBoardBusy(true)
    setBoardAdminMessage('')
    try {
      const { data } = await api.get('/board-tiles')
      setBoardTiles(data.boardTiles || [])
    } catch (error) {
      const message = getApiError(error)
      setRoomMessage(message)
      setBoardAdminMessage(message)
    } finally {
      setBoardBusy(false)
    }
  }

  async function updateBoardTile(tileNumber, payload) {
    if (!user || user.role !== 'admin') {
      setBoardAdminMessage('Admin access required')
      return { ok: false }
    }

    const nextPayload = { ...payload }
    if (typeof nextPayload.qrPayload === 'string') {
      nextPayload.qrPayload = nextPayload.qrPayload.trim().toUpperCase()
      if (!QR_PAYLOAD_PATTERN.test(nextPayload.qrPayload)) {
        const message =
          'QR payload must be 3-120 characters and use only letters, numbers, colon, underscore, or hyphen'
        setBoardAdminMessage(message)
        return { ok: false, message }
      }
    }

    setBoardAdminBusy(true)
    setBoardAdminMessage('')
    try {
      const { data } = await api.patch(`/board-tiles/${tileNumber}`, nextPayload)
      setBoardTiles((prev) =>
        prev.map((tile) => (tile.tileNumber === tileNumber ? { ...tile, ...data.boardTile } : tile)),
      )
      if (boardQrPreview?.tileNumber === tileNumber) {
        setBoardQrPreview(null)
      }
      setBoardPrintSheet(null)
      setBoardAdminMessage(`Tile ${tileNumber} updated`)
      return { ok: true, boardTile: data.boardTile }
    } catch (error) {
      const message = getApiError(error)
      setBoardAdminMessage(message)
      return { ok: false, message }
    } finally {
      setBoardAdminBusy(false)
    }
  }

  async function loadBoardPrintSheet() {
    if (!user) return

    setBoardPrintBusy(true)
    setBoardPrintMessage('')
    try {
      const { data } = await api.get('/board-tiles/print-sheet')
      setBoardPrintSheet(data)
    } catch (error) {
      setBoardPrintMessage(getApiError(error))
    } finally {
      setBoardPrintBusy(false)
    }
  }

  async function previewTileQr(tileNumber) {
    try {
      const { data } = await api.get(`/board-tiles/${tileNumber}/qr`)
      setBoardQrPreview(data)
    } catch (error) {
      setScanMessage(getApiError(error))
    }
  }

  async function loadRoomHistory(roomCodeOverride) {
    const roomCode = (roomCodeOverride || currentRoomCode).trim().toUpperCase()
    if (!roomCode || !user) {
      setRoomHistory([])
      return
    }

    setHistoryBusy(true)
    setHistoryMessage('')
    try {
      const { data } = await api.get(`/rooms/${roomCode}/history`)
      setRoomHistory(data.attempts || [])
    } catch (error) {
      setHistoryMessage(getApiError(error))
    } finally {
      setHistoryBusy(false)
    }
  }

  async function loadQuestions() {
    if (!user || user.role !== 'admin') return

    setQuestionsBusy(true)
    setQuestionsMessage('')
    try {
      const { data } = await api.get('/questions?includeInactive=true')
      setQuestions(data.questions || [])
    } catch (error) {
      setQuestionsMessage(getApiError(error))
    } finally {
      setQuestionsBusy(false)
    }
  }

  function updateQuestionOption(index, patch) {
    setQuestionForm((prev) => {
      const nextOptions = [...prev.options]
      nextOptions[index] = { ...nextOptions[index], ...patch }
      return { ...prev, options: nextOptions }
    })
  }

  function markCorrectOption(index) {
    setQuestionForm((prev) => ({
      ...prev,
      options: prev.options.map((option, optionIndex) => ({
        ...option,
        isCorrect: optionIndex === index,
      })),
    }))
  }

  function resetQuestionEditor() {
    setEditingQuestionId(null)
    setQuestionForm(createBlankQuestionForm())
  }

  function beginEditQuestion(question) {
    setEditingQuestionId(question.id)
    setQuestionForm({
      prompt: question.prompt,
      difficulty: question.difficulty,
      explanation: question.explanation || '',
      options: question.options.map((option) => ({
        optionText: option.optionText,
        isCorrect: Boolean(option.isCorrect),
      })),
    })
  }

  async function saveQuestion(event) {
    event.preventDefault()
    const validationMessage = validateQuestionFormInput(questionForm)
    if (validationMessage) {
      setQuestionsMessage(validationMessage)
      return
    }

    setQuestionsBusy(true)
    setQuestionsMessage('')

    try {
      if (editingQuestionId) {
        await api.patch(`/questions/${editingQuestionId}`, questionForm)
        setQuestionsMessage('Question updated')
      } else {
        await api.post('/questions', questionForm)
        setQuestionsMessage('Question created')
      }

      resetQuestionEditor()
      await loadQuestions()
    } catch (error) {
      setQuestionsMessage(getApiError(error))
      setQuestionsBusy(false)
    }
  }

  async function activateQuestion(questionId) {
    setQuestionsBusy(true)
    setQuestionsMessage('')

    try {
      await api.patch(`/questions/${questionId}`, { isActive: true })
      await loadQuestions()
      setQuestionsMessage('Question activated')
    } catch (error) {
      setQuestionsMessage(getApiError(error))
      setQuestionsBusy(false)
    }
  }

  async function deactivateQuestion(questionId) {
    if (!window.confirm('Deactivate this question? It will no longer appear in gameplay.')) {
      return
    }

    setQuestionsBusy(true)
    setQuestionsMessage('')

    try {
      await api.delete(`/questions/${questionId}`)
      await loadQuestions()
      setQuestionsMessage('Question deactivated')
      if (editingQuestionId === questionId) {
        resetQuestionEditor()
      }
    } catch (error) {
      setQuestionsMessage(getApiError(error))
      setQuestionsBusy(false)
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark" aria-hidden="true">
            FQ
          </div>
          <div>
            <p className="brand-eyebrow">FWDD Hybrid Game</p>
            <h1 className="brand-title">Function Quest Race</h1>
          </div>
        </div>

        <nav className="main-nav" aria-label="Main navigation">
          <NavItem to="/">Dashboard</NavItem>
          <NavItem to="/play">Play</NavItem>
          <NavItem to="/admin">Admin</NavItem>
        </nav>

        <div className="topbar-actions">
          <div className={`topbar-chip ${socketStatus === 'connected' ? 'good' : 'warn'}`}>
            {socketStatus === 'connected' ? 'Live' : 'Offline'}
          </div>
          {user ? (
            <div className="topbar-user">
              <span>{user.displayName}</span>
              <button type="button" className="ghost small" onClick={handleLogout}>
                Logout
              </button>
            </div>
          ) : (
            <div className="topbar-chip neutral">Guest</div>
          )}
        </div>
      </header>

      <section className="hero-strip">
        <div className="hero-copy">
          <p className="section-eyebrow">Python Functions • Multiplayer • QR Board</p>
          <h2>Prototype control center for the hybrid game assignment</h2>
          <p>
            This build includes authentication, room management, QR tile challenges, live score updates,
            board QR previews, and an admin question bank backed by PostgreSQL.
          </p>
        </div>
        <div className="status-grid">
          <StatusPill label="API" value={health.status} tone={health.status === 'online' ? 'good' : 'warn'} />
          <StatusPill label="Socket" value={socketStatus} tone={socketStatus === 'connected' ? 'good' : 'warn'} />
          <StatusPill label="User" value={user ? user.role : 'guest'} tone={user ? 'good' : 'neutral'} />
          <StatusPill label="Room" value={currentRoomCode || 'none'} tone={currentRoomCode ? 'good' : 'neutral'} />
        </div>
      </section>

      <Routes>
        <Route
          path="/"
          element={
            <DashboardPage
              auth={{
                user,
                authMode,
                setAuthMode,
                authForm,
                setAuthForm,
                authBusy,
                authMessage,
                onSubmit: handleAuthSubmit,
                onLogout: handleLogout,
              }}
              room={{
                user,
                roomCodeInput,
                setRoomCodeInput,
                roomBusy,
                roomMessage,
                roomState,
                currentRoomCode,
                createRoom,
                joinRoom,
                refreshRoom,
                startRoom,
                finishRoom,
                copyRoomCode,
              }}
              boardPrint={{
                sheet: boardPrintSheet,
                busy: boardPrintBusy,
                message: boardPrintMessage,
                load: loadBoardPrintSheet,
              }}
              live={{
                scoreboard,
                liveFeed,
                roomHistory,
                historyBusy,
                historyMessage,
                refreshHistory: loadRoomHistory,
                currentRoomCode,
              }}
            />
          }
        />
        <Route
          path="/play"
          element={
            <PlayPage
              user={user}
              game={{
                scanPayload,
                setScanPayload,
                scanBusy,
                scanMessage,
                activePrompt,
                selectedOptionId,
                setSelectedOptionId,
                attemptResult,
                scanTile,
                submitAnswer,
              }}
              room={{ currentRoomCode, roomState, roomMessage }}
              live={{ scoreboard, liveFeed, roomHistory, historyBusy, historyMessage, refreshHistory: loadRoomHistory }}
              board={{
                boardTiles,
                boardBusy,
                boardQrPreview,
                loadBoardTiles,
                previewTileQr,
                setScanPayload,
                currentScanPayload: scanPayload,
              }}
            />
          }
        />
        <Route
          path="/board-print"
          element={
            <BoardPrintPage
              user={user}
              room={{ roomState, currentRoomCode }}
              boardPrint={{
                sheet: boardPrintSheet,
                busy: boardPrintBusy,
                message: boardPrintMessage,
                load: loadBoardPrintSheet,
              }}
            />
          }
        />
        <Route
          path="/admin"
          element={
            <AdminPage
              user={user}
              questions={{
                questions,
                questionsBusy,
                questionsMessage,
                loadQuestions,
                activateQuestion,
                deactivateQuestion,
              }}
              editor={{
                editingQuestionId,
                questionForm,
                setQuestionForm,
                updateQuestionOption,
                markCorrectOption,
                beginEditQuestion,
                resetQuestionEditor,
                saveQuestion,
              }}
              boardAdmin={{
                boardTiles,
                boardBusy,
                boardAdminBusy,
                boardAdminMessage,
                loadBoardTiles,
                updateBoardTile,
              }}
            />
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  )
}

function DashboardPage({ auth, room, boardPrint, live }) {
  const isHost = Boolean(
    auth.user &&
      room.roomState &&
      room.roomState.room.hostUserId === auth.user.id,
  )

	  const roomStatus = room.roomState?.room?.status || null
	  const roomTurn = room.roomState?.turn || null
  const canStartRoom = Boolean(room.user && room.roomState && isHost && roomStatus !== 'active' && roomStatus !== 'finished')
  const canFinishRoom = Boolean(room.user && room.roomState && isHost && roomStatus !== 'finished')

  return (
    <main className="page-grid">
      <section className="panel panel-auth">
        <div className="panel-head">
          <h3>Authentication</h3>
          {auth.user ? (
            <button className="ghost small" type="button" onClick={auth.onLogout}>
              Sign out
            </button>
          ) : null}
        </div>

        {!auth.user ? (
          <form className="stack" onSubmit={auth.onSubmit}>
            <div className="mode-switch">
              <button
                type="button"
                className={auth.authMode === 'login' ? 'active' : ''}
                onClick={() => auth.setAuthMode('login')}
              >
                Login
              </button>
              <button
                type="button"
                className={auth.authMode === 'register' ? 'active' : ''}
                onClick={() => auth.setAuthMode('register')}
              >
                Register
              </button>
            </div>

            <label>
              Email
              <input
                type="email"
                value={auth.authForm.email}
                onChange={(event) =>
                  auth.setAuthForm((prev) => ({ ...prev, email: event.target.value }))
                }
                required
              />
            </label>

            {auth.authMode === 'register' ? (
              <label>
                Display Name
                <input
                  type="text"
                  value={auth.authForm.displayName}
                  onChange={(event) =>
                    auth.setAuthForm((prev) => ({ ...prev, displayName: event.target.value }))
                  }
                  required
                />
              </label>
            ) : null}

            <label>
              Password
              <input
                type="password"
                value={auth.authForm.password}
                onChange={(event) =>
                  auth.setAuthForm((prev) => ({ ...prev, password: event.target.value }))
                }
                required
              />
            </label>

            <button type="submit" disabled={auth.authBusy}>
              {auth.authBusy ? 'Working...' : auth.authMode === 'login' ? 'Login' : 'Create Account'}
            </button>
          </form>
        ) : (
          <div className="stack">
            <div className="stat-card">
              <span>Current User</span>
              <strong>{auth.user.displayName}</strong>
              <small>{auth.user.email}</small>
            </div>
            <div className="stat-card inline">
              <span>Role</span>
              <strong>{auth.user.role}</strong>
            </div>
          </div>
        )}

        {auth.authMessage ? <p className="notice">{auth.authMessage}</p> : null}
      </section>

      <section className="panel panel-room">
        <div className="panel-head">
          <h3>Room Control</h3>
          <div className="row tight">
            <button className="ghost small" type="button" onClick={room.refreshRoom} disabled={room.roomBusy}>
              Refresh
            </button>
            <button
              className="ghost small"
              type="button"
              onClick={room.copyRoomCode}
              disabled={!room.currentRoomCode}
            >
              Copy Code
            </button>
          </div>
        </div>

        <div className="stack">
          <label>
            Room Code
            <input
              type="text"
              value={room.roomCodeInput}
              onChange={(event) => room.setRoomCodeInput(event.target.value.toUpperCase())}
              placeholder="ABC123"
              disabled={!room.user}
            />
          </label>

	          <div className="row">
	            <button type="button" onClick={room.createRoom} disabled={!room.user || room.roomBusy}>
              Create Room
            </button>
            <button type="button" onClick={room.joinRoom} disabled={!room.user || room.roomBusy}>
              Join Room
            </button>
	            <button type="button" onClick={room.startRoom} disabled={room.roomBusy || !canStartRoom}>
	              Start Room
	            </button>
	            <button
	              type="button"
	              className="ghost danger"
	              onClick={room.finishRoom}
		              disabled={room.roomBusy || !canFinishRoom}
		            >
		              Finish Room
		            </button>
	            {isHost && room.roomState ? (
	              <Link className="ghost-link small-link" to="/board-print">
	                Board Print Studio
	              </Link>
	            ) : null}
	          </div>

          {room.roomState ? (
            <div className="card inset">
              <div className="meta-grid">
                <span>Room</span>
                <strong>{room.roomState.room.roomCode}</strong>
                <span>Status</span>
                <strong>{room.roomState.room.status}</strong>
                <span>Players</span>
                <strong>{room.roomState.players.length}</strong>
                <span>Host</span>
                <strong>
                  {room.roomState.players.find((player) => player.userId === room.roomState.room.hostUserId)
                    ?.displayName || room.roomState.room.hostUserId}
                </strong>
                <span>Round</span>
                <strong>{roomTurn?.roundNumber ?? 1}</strong>
                <span>Turn</span>
                <strong>{roomTurn?.currentTurnDisplayName || (roomStatus === 'finished' ? 'Closed' : 'Pending')}</strong>
              </div>
            </div>
          ) : (
            <EmptyState title="No room selected" body="Create a room or join an existing room to begin multiplayer play." />
          )}

            {room.roomState && room.user && !isHost ? (
              <p className="notice">Only the room host can start, finish, or open the board print tools.</p>
            ) : null}
	          {boardPrint.message ? <p className="notice">{boardPrint.message}</p> : null}
	          {room.roomMessage ? <p className="notice">{room.roomMessage}</p> : null}
	        </div>
	      </section>

      <section className="panel panel-scoreboard">
        <div className="panel-head">
          <h3>Live Scoreboard</h3>
        </div>
        <WinnerSummaryCard roomStatus={roomStatus} scoreboard={live.scoreboard} />
        <ScoreboardCard scoreboard={live.scoreboard} />
      </section>

      <section className="panel panel-activity panel-span-6">
        <div className="panel-head">
          <h3>Recent Activity</h3>
        </div>
        <ActivityFeedCard liveFeed={live.liveFeed} />
      </section>

      <section className="panel panel-history panel-span-6">
        <div className="panel-head">
          <h3>Room Attempt History</h3>
          <button
            className="ghost small"
            type="button"
            onClick={() => live.refreshHistory()}
            disabled={!live.currentRoomCode || live.historyBusy}
          >
            Reload
          </button>
        </div>
        <HistoryCard
          attempts={live.roomHistory}
          busy={live.historyBusy}
          message={live.historyMessage}
          roomCode={live.currentRoomCode}
        />
      </section>
    </main>
  )
}

function PlayPage({ user, game, room, live, board }) {
  const roomStatus = room.roomState?.room?.status || null
  const turn = room.roomState?.turn || null
  const isUsersTurn = Boolean(!user || !turn?.currentTurnUserId || turn.currentTurnUserId === user.id)
  const canInteract = Boolean(user && room.currentRoomCode) && roomStatus === 'active' && isUsersTurn

  return (
    <main className="page-grid">
      <section className="panel panel-game panel-span-7">
        <div className="panel-head">
          <h3>QR Challenge</h3>
          <span className="panel-badge">Gameplay</span>
        </div>

        <div className="stack">
          <div className="row">
            <input
              type="text"
              value={game.scanPayload}
              onChange={(event) => game.setScanPayload(event.target.value.toUpperCase())}
              placeholder="FQ-TILE-01"
              disabled={!user}
            />
            <button type="button" onClick={game.scanTile} disabled={!user || game.scanBusy || !canInteract}>
              {game.scanBusy ? 'Loading...' : 'Scan Tile'}
            </button>
          </div>

          {room.currentRoomCode ? (
            <div className="strip-card">
              <span>Room</span>
              <strong>{room.currentRoomCode}</strong>
              <span>Status</span>
              <strong>{room.roomState?.room?.status || 'unknown'}</strong>
              <span>Round</span>
              <strong>{turn?.roundNumber ?? 1}</strong>
              <span>Turn</span>
              <strong>{turn?.currentTurnDisplayName || (roomStatus === 'finished' ? 'Closed' : 'Pending')}</strong>
            </div>
          ) : (
            <EmptyState title="Room required" body="Use the Dashboard page to create or join a room before scanning a tile." compact />
          )}

          <TurnBanner user={user} roomStatus={roomStatus} turn={turn} />

          <CameraScannerCard
            disabled={!user || !room.currentRoomCode}
            onDetected={(value) => game.setScanPayload(value)}
          />

          {game.activePrompt?.question ? (
            <div className="card challenge">
              <p className="tile-tag">
                Tile {game.activePrompt.tileNumber} • {game.activePrompt.question.difficulty}
              </p>
              <h3>{game.activePrompt.question.prompt}</h3>

              <div className="options">
                {game.activePrompt.question.options.map((option) => (
                  <label key={option.id} className={`option ${game.selectedOptionId === option.id ? 'selected' : ''}`}>
                    <input
                      type="radio"
                      name="answer"
                      value={option.id}
                      checked={game.selectedOptionId === option.id}
                      onChange={(event) => game.setSelectedOptionId(event.target.value)}
                    />
                    <span>
                      {option.position}. {option.optionText}
                    </span>
                  </label>
                ))}
              </div>

              <button type="button" onClick={game.submitAnswer} disabled={game.scanBusy || !game.selectedOptionId || !canInteract}>
                Submit Answer
              </button>
            </div>
          ) : null}

          {game.attemptResult ? (
            <div className={`card result ${game.attemptResult.isCorrect ? 'correct' : 'wrong'}`}>
              <p>
                {game.attemptResult.isCorrect ? 'Correct' : 'Incorrect'} • {game.attemptResult.awardedPoints} points
              </p>
              {game.attemptResult.scoring ? (
                <div className="result-breakdown">
                  <span className={`badge ${game.attemptResult.scoring.difficulty}`}>
                    {game.attemptResult.scoring.difficulty}
                  </span>
                  <span>Base {game.attemptResult.scoring.basePoints} pts</span>
                  {game.attemptResult.scoring.bonusPoints ? (
                    <span className="bonus-pill">+{game.attemptResult.scoring.bonusPoints} speed bonus</span>
                  ) : (
                    <span className="supporting-text">
                      Speed bonus under {Math.round(game.attemptResult.scoring.speedBonusThresholdMs / 1000)}s
                    </span>
                  )}
                </div>
              ) : null}
              <p className="supporting-text">{game.attemptResult.explanation}</p>
            </div>
          ) : null}

          {game.scanMessage ? <p className="notice">{game.scanMessage}</p> : null}
        </div>
      </section>

      <section className="panel panel-scoreboard panel-span-5">
        <div className="panel-head">
          <h3>Live Scoreboard</h3>
        </div>
        <WinnerSummaryCard roomStatus={roomStatus} scoreboard={live.scoreboard} />
        <ScoreboardCard scoreboard={live.scoreboard} />
      </section>

      <section className="panel panel-board panel-span-6">
        <div className="panel-head">
          <h3>Board Tiles</h3>
          <button className="ghost small" type="button" onClick={board.loadBoardTiles} disabled={!user || board.boardBusy}>
            Reload
          </button>
        </div>

        {!user ? (
          <EmptyState title="Login required" body="Sign in to view tile mappings and generate QR previews." compact />
        ) : (
          <div className="stack">
            <div className="tile-grid">
              {board.boardTiles.slice(0, 12).map((tile) => (
                <button
                  key={tile.id}
                  type="button"
                  className={`tile-btn ${board.currentScanPayload === tile.qrPayload ? 'active' : ''}`}
                  onClick={() => {
                    board.setScanPayload(tile.qrPayload)
                    board.previewTileQr(tile.tileNumber)
                  }}
                >
                  <span>#{tile.tileNumber}</span>
                  <small>{tile.qrPayload}</small>
                </button>
              ))}
            </div>

            {board.boardQrPreview ? (
              <div className="card qr-card">
                <div>
                  <p className="tile-tag">Tile {board.boardQrPreview.tileNumber}</p>
                  <p className="supporting-text monospace">{board.boardQrPreview.qrPayload}</p>
                </div>
                <img src={board.boardQrPreview.qrDataUrl} alt={`QR preview for tile ${board.boardQrPreview.tileNumber}`} />
              </div>
            ) : null}
          </div>
        )}
      </section>

      <section className="panel panel-activity panel-span-6">
        <div className="panel-head">
          <h3>Recent Activity</h3>
        </div>
        <ActivityFeedCard liveFeed={live.liveFeed} />
      </section>

      <section className="panel panel-history panel-span-12">
        <div className="panel-head">
          <h3>Attempt History</h3>
          <button
            className="ghost small"
            type="button"
            onClick={() => live.refreshHistory()}
            disabled={!room.currentRoomCode || live.historyBusy}
          >
            Reload
          </button>
        </div>
        <HistoryCard
          attempts={live.roomHistory}
          busy={live.historyBusy}
          message={live.historyMessage}
          roomCode={room.currentRoomCode}
        />
      </section>
    </main>
  )
}

function TurnBanner({ user, roomStatus, turn }) {
  if (!roomStatus) return null

  if (roomStatus === 'lobby') {
    return (
      <div className="turn-banner info">
        <span className="turn-banner-label">Room Status</span>
        <strong>Waiting for host to start the room</strong>
      </div>
    )
  }

  if (roomStatus === 'finished') {
    return (
      <div className="turn-banner muted">
        <span className="turn-banner-label">Room Status</span>
        <strong>Room finished</strong>
      </div>
    )
  }

  const isCurrent = Boolean(user && turn?.currentTurnUserId && user.id === turn.currentTurnUserId)

  return (
    <div className={`turn-banner ${isCurrent ? 'good' : 'warn'}`}>
      <span className="turn-banner-label">Current Turn</span>
      <strong>{turn?.currentTurnDisplayName || 'Pending'}</strong>
      <span className="turn-banner-meta">Round {turn?.roundNumber ?? 1}</span>
      {user ? (
        <span className={`turn-chip ${isCurrent ? 'good' : 'warn'}`}>
          {isCurrent ? 'Your turn' : 'Waiting'}
        </span>
      ) : null}
    </div>
  )
}

function CameraScannerCard({ disabled, onDetected }) {
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const streamRef = useRef(null)
  const rafRef = useRef(null)
  const detectorRef = useRef(null)
  const scanModeRef = useRef('native')
  const lastValueRef = useRef('')
  const lastEmitAtRef = useRef(0)

  const [isOpen, setIsOpen] = useState(false)
  const [isStarting, setIsStarting] = useState(false)
  const [statusText, setStatusText] = useState('Camera idle')
  const [detectedValue, setDetectedValue] = useState('')
  const [cameraFacingMode, setCameraFacingMode] = useState('environment')

  const supportsCamera =
    typeof navigator !== 'undefined' &&
    Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
  useEffect(() => {
    return () => {
      stopCamera()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function stopCamera() {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }

    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop()
      }
      streamRef.current = null
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null
    }

    setIsOpen(false)
    setIsStarting(false)
    setStatusText('Camera idle')
  }

  async function createNativeDetectorIfSupported() {
    if (typeof window === 'undefined' || !('BarcodeDetector' in window)) {
      return null
    }

    try {
      if (typeof window.BarcodeDetector.getSupportedFormats === 'function') {
        const formats = await window.BarcodeDetector.getSupportedFormats()
        if (!formats.includes('qr_code')) {
          return null
        }
      }

      return new window.BarcodeDetector({ formats: ['qr_code'] })
    } catch {
      return null
    }
  }

  function emitDetectedValue(rawValue) {
    const normalized = String(rawValue || '')
      .trim()
      .toUpperCase()

    if (!normalized) return

    const now = Date.now()
    if (normalized !== lastValueRef.current || now - lastEmitAtRef.current > 1500) {
      lastValueRef.current = normalized
      lastEmitAtRef.current = now
      setDetectedValue(normalized)
      setStatusText('QR detected')
      onDetected(normalized)
    }
  }

  function detectWithJsQr(videoElement) {
    const canvas = canvasRef.current
    if (!canvas) return

    const width = videoElement.videoWidth || 0
    const height = videoElement.videoHeight || 0

    if (!width || !height) return

    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height

    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return

    context.drawImage(videoElement, 0, 0, width, height)
    const imageData = context.getImageData(0, 0, width, height)
    const code = jsQR(imageData.data, width, height, {
      inversionAttempts: 'dontInvert',
    })

    if (code?.data) {
      emitDetectedValue(code.data)
    }
  }

  async function detectLoop() {
    if (!videoRef.current) {
      return
    }

    try {
      if (videoRef.current.readyState >= 2) {
        if (detectorRef.current) {
          const results = await detectorRef.current.detect(videoRef.current)
          const rawValue = results?.[0]?.rawValue
          if (rawValue) {
            emitDetectedValue(rawValue)
          }
        } else {
          detectWithJsQr(videoRef.current)
        }
      }
    } catch {
      setStatusText(
        scanModeRef.current === 'fallback'
          ? 'Compatibility scanner paused'
          : 'Camera scanning paused'
      )
    }

    rafRef.current = requestAnimationFrame(detectLoop)
  }

  async function startCamera(preferredFacingMode = cameraFacingMode) {
    if (disabled) return
    if (!supportsCamera) {
      setStatusText('Camera access unavailable')
      return
    }

    setIsStarting(true)
    setStatusText('Opening camera…')

    try {
      const detector = await createNativeDetectorIfSupported()
      detectorRef.current = detector
      scanModeRef.current = detector ? 'native' : 'fallback'

      let stream
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: preferredFacingMode },
          },
          audio: false,
        })
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false,
        })
      }

      streamRef.current = stream

      setIsOpen(true)
      setStatusText('Preparing camera preview…')

      // Wait one paint so the video element is mounted before attaching the stream.
      await new Promise((resolve) => requestAnimationFrame(resolve))

      if (!videoRef.current) {
        throw new Error('Camera preview could not be mounted')
      }

      videoRef.current.playsInline = true
      videoRef.current.muted = true
      videoRef.current.autoplay = true
      videoRef.current.srcObject = stream

      try {
        await videoRef.current.play()
      } catch {
        // Some mobile browsers need metadata first before play() resolves reliably.
      }

      if (videoRef.current.readyState < 2) {
        await new Promise((resolve) => {
          const video = videoRef.current
          if (!video) {
            resolve()
            return
          }

          const onReady = () => {
            video.removeEventListener('loadedmetadata', onReady)
            video.removeEventListener('canplay', onReady)
            resolve()
          }

          video.addEventListener('loadedmetadata', onReady, { once: true })
          video.addEventListener('canplay', onReady, { once: true })
          setTimeout(onReady, 1500)
        })
      }

      // Retry once after metadata if the first play attempt was ignored.
      try {
        await videoRef.current.play()
      } catch {
        // If playback is still blocked, scanning may still work on some browsers.
      }

      setStatusText(detector ? 'Scanning for QR codes' : 'Scanning (compatibility mode)')
      setIsStarting(false)
      detectLoop()
    } catch (error) {
      stopCamera()
      setStatusText(error?.message || 'Unable to start camera')
    }
  }

  async function toggleCameraFacing() {
    const nextFacingMode = cameraFacingMode === 'environment' ? 'user' : 'environment'
    setCameraFacingMode(nextFacingMode)
    setDetectedValue('')
    lastValueRef.current = ''
    lastEmitAtRef.current = 0

    if (!isOpen) {
      setStatusText(`Camera idle (${nextFacingMode === 'environment' ? 'rear' : 'front'} lens selected)`)
      return
    }

    stopCamera()
    setTimeout(() => {
      startCamera(nextFacingMode)
    }, 80)
  }

  return (
    <div className="camera-card">
      <div className="panel-head compact-head">
        <h4>Camera Scanner</h4>
        <div className="row tight">
          <button
            type="button"
            className="ghost small"
            onClick={toggleCameraFacing}
            disabled={disabled || isStarting}
          >
            Lens: {cameraFacingMode === 'environment' ? 'Rear' : 'Front'}
          </button>
          {!isOpen ? (
            <button
              type="button"
              className="ghost small"
              onClick={startCamera}
              disabled={disabled || isStarting}
            >
              {isStarting ? 'Starting…' : 'Open Camera'}
            </button>
          ) : (
            <button type="button" className="ghost small" onClick={stopCamera}>
              Close Camera
            </button>
          )}
        </div>
      </div>

      <div className="camera-stage">
        {isOpen ? (
          <>
            <video ref={videoRef} className="camera-video" playsInline muted />
            <canvas ref={canvasRef} hidden aria-hidden="true" />
          </>
        ) : (
          <div className="camera-placeholder">
            <span>Camera preview</span>
          </div>
        )}
      </div>

      <div className="camera-footer">
        <span className={`scanner-status ${isOpen ? 'good' : 'neutral'}`}>{statusText}</span>
        <span className="scanner-status neutral">
          {cameraFacingMode === 'environment' ? 'Rear lens' : 'Front lens'}
        </span>
        {detectedValue ? (
          <span className="scanner-output monospace">{detectedValue}</span>
        ) : null}
      </div>
    </div>
  )
}

function BoardPrintPage({ user, room, boardPrint }) {
  const printAreaRef = useRef(null)
  const [downloadBusy, setDownloadBusy] = useState(false)
  const [downloadMessage, setDownloadMessage] = useState('')

  const isHost = Boolean(
    user &&
      room.roomState &&
      room.roomState.room.hostUserId === user.id,
  )
  const hasRoom = Boolean(room.roomState && room.currentRoomCode)
  const canAccess = Boolean(user && hasRoom && isHost)
  const tiles = boardPrint.sheet?.tiles ?? []

  const scoring = {
    easy: boardPrint.sheet?.board?.scoring?.easy ?? SCORING_MODEL.easy,
    medium: boardPrint.sheet?.board?.scoring?.medium ?? SCORING_MODEL.medium,
    hard: boardPrint.sheet?.board?.scoring?.hard ?? SCORING_MODEL.hard,
    speedBonusPoints:
      boardPrint.sheet?.board?.scoring?.speedBonusPoints ?? SCORING_MODEL.speedBonusPoints,
    speedBonusMaxMs:
      boardPrint.sheet?.board?.scoring?.speedBonusMaxMs ?? SCORING_MODEL.speedBonusMaxMs,
  }

  useEffect(() => {
    if (!canAccess || boardPrint.sheet || boardPrint.busy) return
    boardPrint.load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canAccess, boardPrint.sheet, boardPrint.busy])

  async function handleDownloadPng() {
    if (!canAccess || !printAreaRef.current) return

    setDownloadBusy(true)
    setDownloadMessage('')
    try {
      const canvas = await html2canvas(printAreaRef.current, {
        backgroundColor: '#ffffff',
        scale: 2,
        useCORS: true,
      })
      const link = document.createElement('a')
      link.download = `function-quest-board-${room.currentRoomCode || 'print'}.png`
      link.href = canvas.toDataURL('image/png')
      link.click()
    } catch {
      setDownloadMessage('PNG export failed on this browser. Use Print Board instead.')
    } finally {
      setDownloadBusy(false)
    }
  }

  function handlePrintBoard() {
    if (!canAccess) return
    window.print()
  }

  if (!user) {
    return (
      <main className="page-grid">
        <section className="panel panel-span-12">
          <div className="panel-head">
            <h3>Board Print Studio</h3>
          </div>
          <EmptyState title="Login required" body="Sign in first, then create or join a room as the host to print the board." />
        </section>
      </main>
    )
  }

  if (!hasRoom) {
    return (
      <main className="page-grid">
        <section className="panel panel-span-12">
          <div className="panel-head">
            <h3>Board Print Studio</h3>
            <Link className="ghost-link small-link" to="/">
              Back to Dashboard
            </Link>
          </div>
          <EmptyState title="No room selected" body="Create or join a room on the Dashboard first. The current room host can then print the board." />
        </section>
      </main>
    )
  }

  if (!isHost) {
    return (
      <main className="page-grid">
        <section className="panel panel-span-12">
          <div className="panel-head">
            <h3>Board Print Studio</h3>
            <Link className="ghost-link small-link" to="/">
              Back to Dashboard
            </Link>
          </div>
          <EmptyState title="Host access required" body="Only the room host can open the board print tools for this session." />
        </section>
      </main>
    )
  }

  return (
    <main className="page-grid board-print-page">
      <section className="panel panel-span-12 no-print">
        <div className="panel-head">
          <h3>Board Print Studio</h3>
          <div className="row tight">
            <Link className="ghost-link small-link" to="/">
              Dashboard
            </Link>
            <button className="ghost small" type="button" onClick={boardPrint.load} disabled={boardPrint.busy}>
              {boardPrint.busy ? 'Loading…' : 'Reload Board'}
            </button>
            <button type="button" onClick={handleDownloadPng} disabled={boardPrint.busy || !tiles.length || downloadBusy}>
              {downloadBusy ? 'Preparing PNG…' : 'Download PNG'}
            </button>
            <button type="button" className="ghost small" onClick={handlePrintBoard} disabled={boardPrint.busy || !tiles.length}>
              Print Board
            </button>
          </div>
        </div>
        <div className="print-meta-grid">
          <div className="stat-card inline">
            <span>Room</span>
            <strong>{room.currentRoomCode}</strong>
          </div>
          <div className="stat-card inline">
            <span>Tiles</span>
            <strong>{tiles.length || '...'}</strong>
          </div>
          <div className="stat-card inline">
            <span>Scoring</span>
            <strong>E {scoring.easy} / M {scoring.medium} / H {scoring.hard}</strong>
          </div>
          <div className="stat-card inline">
            <span>Speed Bonus</span>
            <strong>
              +{scoring.speedBonusPoints} under {Math.round(scoring.speedBonusMaxMs / 1000)}s
            </strong>
          </div>
        </div>
        {boardPrint.message ? <p className="notice">{boardPrint.message}</p> : null}
        {downloadMessage ? <p className="notice">{downloadMessage}</p> : null}
      </section>

      <section className="panel panel-span-12 board-sheet-panel">
        {boardPrint.busy && !tiles.length ? (
          <div className="loading-row">Loading printable board…</div>
        ) : !tiles.length ? (
          <EmptyState title="No tiles available" body="No active board tiles were returned from the server." compact />
        ) : (
          <div ref={printAreaRef} className="board-print-sheet">
            <div className="board-sheet-header">
              <h2>{boardPrint.sheet?.board?.title || 'Function Quest Race'} Board</h2>
            </div>

            <div className="board-sheet-grid">
              {tiles.map((tile) => (
                <article key={tile.id} className="board-sheet-tile">
                  <div className="board-sheet-tile-head">
                    <strong>Tile {tile.tileNumber}</strong>
                  </div>
                  <img src={tile.qrDataUrl} alt={`Board QR for tile ${tile.tileNumber}`} loading="lazy" />
                </article>
              ))}
            </div>
          </div>
        )}
      </section>
    </main>
  )
}

function AdminPage({ user, questions, editor, boardAdmin }) {
  if (!user || user.role !== 'admin') {
    return (
      <main className="page-grid">
        <section className="panel panel-span-12">
          <div className="panel-head">
            <h3>Admin Question Bank</h3>
          </div>
          <EmptyState title="Admin access required" body="Sign in with the admin account to manage the Python Functions question bank." />
        </section>
      </main>
    )
  }

  return (
    <main className="page-grid">
      <section className="panel panel-span-12">
        <div className="panel-head">
          <h3>Admin Question Bank</h3>
          <button className="ghost small" type="button" onClick={questions.loadQuestions} disabled={questions.questionsBusy}>
            Refresh
          </button>
        </div>

        <div className="admin-layout">
          <form className="stack card inset" onSubmit={editor.saveQuestion}>
            <div className="panel-head compact-head">
              <h4>{editor.editingQuestionId ? 'Edit Question' : 'Create Question'}</h4>
              {editor.editingQuestionId ? (
                <button type="button" className="ghost small" onClick={editor.resetQuestionEditor}>
                  Cancel Edit
                </button>
              ) : null}
            </div>

            <label>
              Prompt
              <textarea
                rows={3}
                value={editor.questionForm.prompt}
                onChange={(event) =>
                  editor.setQuestionForm((prev) => ({ ...prev, prompt: event.target.value }))
                }
                required
              />
            </label>

            <label>
              Difficulty
              <select
                value={editor.questionForm.difficulty}
                onChange={(event) =>
                  editor.setQuestionForm((prev) => ({ ...prev, difficulty: event.target.value }))
                }
              >
                <option value="easy">Easy</option>
                <option value="medium">Medium</option>
                <option value="hard">Hard</option>
              </select>
            </label>

            <label>
              Explanation
              <textarea
                rows={2}
                value={editor.questionForm.explanation}
                onChange={(event) =>
                  editor.setQuestionForm((prev) => ({ ...prev, explanation: event.target.value }))
                }
              />
            </label>

            <div className="option-editor">
              {editor.questionForm.options.map((option, index) => (
                <div className="option-row" key={`option-${index}`}>
                  <button
                    type="button"
                    className={`correct-toggle ${option.isCorrect ? 'active' : ''}`}
                    onClick={() => editor.markCorrectOption(index)}
                  >
                    {option.isCorrect ? 'Correct' : 'Mark'}
                  </button>
                  <input
                    type="text"
                    placeholder={`Option ${index + 1}`}
                    value={option.optionText}
                    onChange={(event) => editor.updateQuestionOption(index, { optionText: event.target.value })}
                    required
                  />
                </div>
              ))}
            </div>

            <button type="submit" disabled={questions.questionsBusy}>
              {questions.questionsBusy
                ? 'Saving...'
                : editor.editingQuestionId
                  ? 'Update Question'
                  : 'Create Question'}
            </button>
          </form>

          <div className="stack">
            <div className="list-header">
              <h4>Question Inventory</h4>
              <span>{questions.questions.length} total</span>
            </div>

            <div className="question-list">
              {questions.questions.map((question) => (
                <article
                  key={question.id}
                  className={`question-item ${question.isActive ? '' : 'inactive'} ${
                    editor.editingQuestionId === question.id ? 'editing' : ''
                  }`}
                >
                  <div className="question-top">
                    <p>{question.prompt}</p>
                    <span className={`badge ${question.difficulty}`}>{question.difficulty}</span>
                  </div>

                  <ul>
                    {question.options.map((option) => (
                      <li key={option.id}>
                        {option.optionText}
                        {option.isCorrect ? <strong> (correct)</strong> : null}
                      </li>
                    ))}
                  </ul>

                  <div className="row compact">
                    <small>{question.isActive ? 'Active' : 'Inactive'}</small>
                    <div className="row tight">
                      <button
                        type="button"
                        className="ghost small"
                        onClick={() => editor.beginEditQuestion(question)}
                      >
                        {editor.editingQuestionId === question.id ? 'Editing' : 'Edit'}
                      </button>
                      {question.isActive ? (
                        <button
                          type="button"
                          className="ghost danger small"
                          onClick={() => questions.deactivateQuestion(question.id)}
                        >
                          Deactivate
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="ghost small"
                          onClick={() => questions.activateQuestion(question.id)}
                        >
                          Activate
                        </button>
                      )}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </div>

        {questions.questionsMessage ? <p className="notice">{questions.questionsMessage}</p> : null}
      </section>

      <section className="panel panel-span-12">
        <BoardTileManager questions={questions.questions} boardAdmin={boardAdmin} />
      </section>
    </main>
  )
}

function BoardTileManager({ questions, boardAdmin }) {
  const [tileDrafts, setTileDrafts] = useState({})
  const [savingTileNumber, setSavingTileNumber] = useState(null)
  const [localMessage, setLocalMessage] = useState('')

  useEffect(() => {
    const nextDrafts = {}
    for (const tile of boardAdmin.boardTiles || []) {
      nextDrafts[tile.tileNumber] = {
        qrPayload: tile.qrPayload || '',
        questionId: tile.questionId || '',
        isActive: Boolean(tile.isActive),
      }
    }
    setTileDrafts(nextDrafts)
  }, [boardAdmin.boardTiles])

  useEffect(() => {
    if (boardAdmin.boardAdminMessage) {
      setLocalMessage('')
    }
  }, [boardAdmin.boardAdminMessage])

  const activeQuestions = questions.filter((question) => question.isActive)

  function updateTileDraft(tileNumber, patch) {
    setTileDrafts((prev) => ({
      ...prev,
      [tileNumber]: {
        ...(prev[tileNumber] || {}),
        ...patch,
      },
    }))
  }

  function resetTileDraft(tile) {
    setTileDrafts((prev) => ({
      ...prev,
      [tile.tileNumber]: {
        qrPayload: tile.qrPayload || '',
        questionId: tile.questionId || '',
        isActive: Boolean(tile.isActive),
      },
    }))
  }

  async function saveTile(tile) {
    const draft = tileDrafts[tile.tileNumber] || {
      qrPayload: tile.qrPayload || '',
      questionId: tile.questionId || '',
      isActive: Boolean(tile.isActive),
    }

    const payload = {
      qrPayload: String(draft.qrPayload || '').trim().toUpperCase(),
      questionId: draft.questionId || null,
      isActive: Boolean(draft.isActive),
    }

    if (!payload.qrPayload) {
      setLocalMessage(`Tile ${tile.tileNumber} QR payload cannot be empty`)
      return
    }
    if (payload.isActive && !payload.questionId) {
      setLocalMessage(`Assign a question before enabling Tile ${tile.tileNumber}`)
      return
    }

    if (tile.isActive && !payload.isActive) {
      const confirmed = window.confirm(
        `Deactivate Tile ${tile.tileNumber}? It will not be available during gameplay.`,
      )
      if (!confirmed) return
    }

    setSavingTileNumber(tile.tileNumber)
    setLocalMessage('')
    const result = await boardAdmin.updateBoardTile(tile.tileNumber, payload)
    setSavingTileNumber(null)

    if (result?.ok && result.boardTile) {
      resetTileDraft(result.boardTile)
    } else if (result?.message) {
      setLocalMessage(result.message)
    }
  }

  return (
    <>
      <div className="panel-head">
        <h3>Board Tile Mapping</h3>
        <button
          className="ghost small"
          type="button"
          onClick={boardAdmin.loadBoardTiles}
          disabled={boardAdmin.boardBusy || boardAdmin.boardAdminBusy}
        >
          {boardAdmin.boardBusy ? 'Loading…' : 'Reload Tiles'}
        </button>
      </div>

      <p className="supporting-text">
        Assign active questions to board tiles and manage tile QR payloads. Difficulty is hidden from the printed board
        and only shown during gameplay.
      </p>

      {boardAdmin.boardAdminMessage ? <p className="notice">{boardAdmin.boardAdminMessage}</p> : null}
      {localMessage ? <p className="notice">{localMessage}</p> : null}

      {!boardAdmin.boardTiles.length && boardAdmin.boardBusy ? (
        <div className="loading-row">Loading board tiles…</div>
      ) : !boardAdmin.boardTiles.length ? (
        <EmptyState title="No board tiles found" body="Create or seed board tiles in the database to manage mappings here." compact />
      ) : (
        <div className="tile-admin-table-wrap">
          <table className="tile-admin-table">
            <thead>
              <tr>
                <th>Tile</th>
                <th>QR Payload</th>
                <th>Question Mapping</th>
                <th>Active</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {boardAdmin.boardTiles.map((tile) => {
                const draft = tileDrafts[tile.tileNumber] || {
                  qrPayload: tile.qrPayload || '',
                  questionId: tile.questionId || '',
                  isActive: Boolean(tile.isActive),
                }
                const isDirty =
                  String(draft.qrPayload || '').trim().toUpperCase() !== String(tile.qrPayload || '') ||
                  String(draft.questionId || '') !== String(tile.questionId || '') ||
                  Boolean(draft.isActive) !== Boolean(tile.isActive)
                const currentQuestion = questions.find((question) => question.id === tile.questionId)
                const selectedQuestionId = String(draft.questionId || '')

                return (
                  <tr key={tile.id}>
                    <td>
                      <strong>#{tile.tileNumber}</strong>
                    </td>
                    <td>
                      <input
                        type="text"
                        value={draft.qrPayload}
                        onChange={(event) =>
                          updateTileDraft(tile.tileNumber, { qrPayload: event.target.value.toUpperCase() })
                        }
                        className="monospace"
                        aria-label={`QR payload for tile ${tile.tileNumber}`}
                      />
                    </td>
                    <td>
                      <select
                        value={selectedQuestionId}
                        onChange={(event) =>
                          updateTileDraft(tile.tileNumber, { questionId: event.target.value })
                        }
                        aria-label={`Question mapping for tile ${tile.tileNumber}`}
                      >
                        <option value="">Unassigned</option>
                        {currentQuestion && !currentQuestion.isActive ? (
                          <option value={currentQuestion.id}>
                            {currentQuestion.prompt.slice(0, 90)} (inactive)
                          </option>
                        ) : null}
                        {activeQuestions.map((question) => (
                          <option key={question.id} value={question.id}>
                            [{question.difficulty}] {question.prompt.slice(0, 90)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <label className="checkbox-cell">
                        <input
                          type="checkbox"
                          checked={Boolean(draft.isActive)}
                          onChange={(event) =>
                            updateTileDraft(tile.tileNumber, { isActive: event.target.checked })
                          }
                        />
                        <span>{draft.isActive ? 'Enabled' : 'Disabled'}</span>
                      </label>
                    </td>
                    <td>
                      <div className="row tight">
                        <button
                          type="button"
                          className="ghost small"
                          onClick={() => resetTileDraft(tile)}
                          disabled={!isDirty || boardAdmin.boardAdminBusy || savingTileNumber === tile.tileNumber}
                        >
                          Reset
                        </button>
                        <button
                          type="button"
                          className="small"
                          onClick={() => saveTile(tile)}
                          disabled={
                            !isDirty ||
                            boardAdmin.boardAdminBusy ||
                            savingTileNumber === tile.tileNumber ||
                            !String(draft.qrPayload || '').trim()
                          }
                        >
                          {savingTileNumber === tile.tileNumber ? 'Saving…' : 'Save'}
                        </button>
                      </div>
                      {tile.questionPrompt ? (
                        <small className="tile-admin-current">
                          Current: {tile.questionPrompt.slice(0, 90)}
                          {tile.questionDifficulty ? ` • ${tile.questionDifficulty}` : ''}
                          {tile.questionIsActive === false ? ' • inactive question' : ''}
                        </small>
                      ) : (
                        <small className="tile-admin-current">Current: Unassigned</small>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

function getWinnerSummary(scoreboard) {
  if (!Array.isArray(scoreboard) || scoreboard.length === 0) {
    return null
  }

  const sorted = [...scoreboard].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if ((a.playerOrder ?? 9999) !== (b.playerOrder ?? 9999)) {
      return (a.playerOrder ?? 9999) - (b.playerOrder ?? 9999)
    }
    return String(a.displayName || '').localeCompare(String(b.displayName || ''))
  })

  const topScore = sorted[0].score ?? 0
  const winners = sorted.filter((player) => player.score === topScore)
  return {
    winners,
    topScore,
    totalPlayers: sorted.length,
  }
}

function WinnerSummaryCard({ roomStatus, scoreboard }) {
  if (roomStatus !== 'finished') return null

  const summary = getWinnerSummary(scoreboard)
  if (!summary) return null

  const winnerNames = summary.winners.map((winner) => winner.displayName)

  return (
    <div className="winner-card">
      <span className="winner-label">Final Result</span>
      <strong>
        {winnerNames.join(', ')} {summary.winners.length > 1 ? 'tie' : 'wins'} with {summary.topScore} pts
      </strong>
      <small>{summary.totalPlayers} player{summary.totalPlayers === 1 ? '' : 's'} in the room</small>
    </div>
  )
}

function ScoreboardCard({ scoreboard }) {
  if (!scoreboard.length) {
    return <EmptyState title="No scores yet" body="Scores will appear after players join a room and answer questions." compact />
  }

  return (
    <ol className="score-list">
      {scoreboard.map((player) => (
        <li key={player.userId}>
          <div>
            <strong>{player.displayName}</strong>
            <span>Tile {player.currentTile}</span>
          </div>
          <span className="points">{player.score} pts</span>
        </li>
      ))}
    </ol>
  )
}

function ActivityFeedCard({ liveFeed }) {
  if (!liveFeed.length) {
    return <EmptyState title="No activity yet" body="Live events will appear here as players answer questions." compact />
  }

  return (
    <div className="feed">
      <ul>
        {liveFeed.map((item) => (
          <li key={item.id}>
            <span>{item.text}</span>
            <small>{item.time}</small>
          </li>
        ))}
      </ul>
    </div>
  )
}

function HistoryCard({ attempts, busy, message, roomCode }) {
  if (!roomCode) {
    return <EmptyState title="No room selected" body="Open a room to view recent attempts and scoring history." compact />
  }

  if (busy) {
    return <div className="loading-row">Loading history…</div>
  }

  if (message) {
    return <p className="notice">{message}</p>
  }

  if (!attempts.length) {
    return <EmptyState title="No attempts recorded" body="Players have not submitted any answers in this room yet." compact />
  }

  return (
    <div className="history-table-wrap">
      <table className="history-table">
        <thead>
          <tr>
            <th>Player</th>
            <th>Question</th>
            <th>Result</th>
            <th>Points</th>
            <th>Time</th>
          </tr>
        </thead>
        <tbody>
          {attempts.map((attempt) => (
            <tr key={attempt.id}>
              <td>{attempt.displayName}</td>
              <td>{attempt.prompt}</td>
              <td>
                <span className={`result-pill ${attempt.isCorrect ? 'correct' : 'wrong'}`}>
                  {attempt.isCorrect ? 'Correct' : 'Wrong'}
                </span>
              </td>
              <td>{attempt.awardedPoints}</td>
              <td>{new Date(attempt.createdAt).toLocaleTimeString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function EmptyState({ title, body, compact = false }) {
  return (
    <div className={`empty-state ${compact ? 'compact' : ''}`}>
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  )
}

function NavItem({ to, children }) {
  return (
    <NavLink to={to} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
      {children}
    </NavLink>
  )
}

function StatusPill({ label, value, tone = 'neutral' }) {
  return (
    <div className={`status-pill ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

export default App
