
import { useEffect, useState } from 'react';
import DashboardPage from './pages/DashboardPage';
import AuthPage from './pages/AuthPage';
import { ThemeProvider } from './context/ThemeContext';
import {
  getAccessToken,
  getCurrentUser,
  logout,
  type AuthUser,
} from './services/auth';

function AppContent() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);

  useEffect(() => {
    let active = true;

    async function restoreSession() {
      const token = getAccessToken();
      if (!token) {
        if (active) {
          setUser(null);
          setCheckingSession(false);
        }
        return;
      }

      try {
        const currentUser = await getCurrentUser();
        if (active && getAccessToken() === token) {
          setUser(currentUser);
        }
      } catch (err) {
        console.error('Session restore failed:', err);
        if (getAccessToken() === token) {
          await logout();
          if (active) {
            setUser(null);
          }
        }
      } finally {
        if (active) {
          setCheckingSession(false);
        }
      }
    }

    void restoreSession();

    return () => {
      active = false;
    };
  }, []);

  async function handleLogout() {
    await logout();
    setUser(null);
  }

  if (checkingSession) {
    return <div style={{ padding: 40 }}>Checking session...</div>;
  }

  if (!user) {
    return <AuthPage onAuthenticated={setUser} />;
  }

  return (
    <DashboardPage user={user} onLogout={handleLogout} />
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AppContent />
    </ThemeProvider>
  );
}
