import { useState, type FormEvent } from 'react';
import { login, register, type AuthUser } from '../services/auth';

interface AuthPageProps {
  onAuthenticated: (user: AuthUser) => void;
}

export default function AuthPage({ onAuthenticated }: AuthPageProps) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  function validateForm(): string | null {
    const trimmedEmail = email.trim();

    if (mode === 'register') {
      const trimmedName = name.trim();
      if (!trimmedName) {
        return 'Please enter your full name.';
      }
      if (trimmedName.length < 2) {
        return 'Full name must be at least 2 characters.';
      }
    }

    if (!trimmedEmail) {
      return 'Please enter your email address.';
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(trimmedEmail)) {
      return 'Please enter a valid email address.';
    }

    if (!password) {
      return 'Please enter your password.';
    }

    if (mode === 'register') {
      if (password.length < 8) {
        return 'Password must contain at least 8 characters.';
      }
      if (!confirmPassword) {
        return 'Please confirm your password.';
      }
      if (password !== confirmPassword) {
        return 'Passwords do not match.';
      }
    }

    return null;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading) return;

    setError('');
    const validationError = validateForm();
    if (validationError) {
      setError(validationError);
      return;
    }

    setLoading(true);

    try {
      const user = mode === 'login'
        ? await login(email.trim(), password)
        : await register(name.trim(), email.trim(), password);

      onAuthenticated(user);
    } catch (err) {
      let errorMessage = 'An unexpected error occurred. Please try again.';
      if (err instanceof Error) {
        if (/failed to fetch|networkerror|econnrefused/i.test(err.message)) {
          errorMessage = 'Unable to connect to the server. Please check your connection.';
        } else if (/request failed \(5\d\d\)|internal server error/i.test(err.message)) {
          errorMessage = 'Service temporarily unavailable. Please try again later.';
        } else {
          errorMessage = err.message;
        }
      }
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  }

  function handleSwitchToRegister() {
    setMode('register');
    setError('');
    setConfirmPassword('');
  }

  function handleSwitchToLogin() {
    setMode('login');
    setError('');
    setConfirmPassword('');
  }

  return (
    <main style={styles.page}>
      <section style={styles.card}>
        <div style={styles.brand}>Cashflow Sentinel</div>
        <h1 style={styles.heading}>
          {mode === 'login' ? 'Welcome back' : 'Create your account'}
        </h1>
        <p style={styles.subtitle}>
          {mode === 'login'
            ? 'Sign in to manage your business cash flow.'
            : 'Get started with intelligent cash-flow monitoring.'}
        </p>

        <form onSubmit={handleSubmit} style={styles.form} noValidate>
          {mode === 'register' && (
            <label style={styles.label}>
              Full name
              <input
                style={styles.input}
                type="text"
                value={name}
                onChange={(e) => { setName(e.target.value); setError(''); }}
                placeholder="e.g. Rajesh Kumar"
                disabled={loading}
                autoComplete="name"
                required
              />
            </label>
          )}

          <label style={styles.label}>
            Email address
            <input
              style={styles.input}
              type="email"
              value={email}
              onChange={(e) => { setEmail(e.target.value); setError(''); }}
              placeholder="you@example.com"
              disabled={loading}
              autoComplete="email"
              required
            />
          </label>

          <label style={styles.label}>
            Password
            <input
              style={styles.input}
              type="password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setError(''); }}
              placeholder={mode === 'register' ? 'At least 8 characters' : 'Enter your password'}
              disabled={loading}
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              required
            />
          </label>

          {mode === 'register' && (
            <label style={styles.label}>
              Confirm password
              <input
                style={styles.input}
                type="password"
                value={confirmPassword}
                onChange={(e) => { setConfirmPassword(e.target.value); setError(''); }}
                placeholder="Re-enter your password"
                disabled={loading}
                autoComplete="new-password"
                required
              />
            </label>
          )}

          {error && (
            <div role="alert" style={styles.errorBox}>
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            style={{
              ...styles.submit,
              ...(loading ? styles.submitDisabled : {}),
            }}
          >
            {loading
              ? (mode === 'login' ? 'Signing in...' : 'Creating account...')
              : (mode === 'login' ? 'Sign in' : 'Create account')}
          </button>
        </form>

        <div style={styles.toggleContainer}>
          {mode === 'login' ? (
            <p style={styles.toggleText}>
              New to Cashflow Sentinel?{' '}
              <button
                type="button"
                style={styles.toggleLink}
                onClick={handleSwitchToRegister}
                disabled={loading}
              >
                Create an account
              </button>
            </p>
          ) : (
            <p style={styles.toggleText}>
              Already have an account?{' '}
              <button
                type="button"
                style={styles.toggleLink}
                onClick={handleSwitchToLogin}
                disabled={loading}
              >
                Sign in
              </button>
            </p>
          )}
        </div>

        <p style={styles.footer}>
          Secure access to your business financial workspace.
        </p>
      </section>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    display: 'grid',
    placeItems: 'center',
    background: '#f4f6fa',
    padding: 24,
    fontFamily: 'Inter, Arial, sans-serif',
  },
  card: {
    width: '100%',
    maxWidth: 440,
    background: '#ffffff',
    padding: 36,
    borderRadius: 16,
    boxShadow: '0 12px 40px rgba(20, 35, 60, 0.08)',
  },
  brand: {
    color: '#2563eb',
    fontSize: 17,
    fontWeight: 700,
    marginBottom: 24,
  },
  heading: { fontSize: 26, margin: '0 0 8px', color: '#172033', fontWeight: 700 },
  subtitle: { color: '#667085', fontSize: 14, lineHeight: 1.6, margin: '0 0 24px' },
  form: { display: 'grid', gap: 16 },
  label: {
    display: 'grid', gap: 6, color: '#344054',
    fontSize: 13, fontWeight: 600,
  },
  input: {
    width: '100%', boxSizing: 'border-box', padding: '12px 14px',
    border: '1px solid #d0d5dd', borderRadius: 8,
    fontSize: 14, color: '#101828', outlineColor: '#2563eb',
    background: '#fff',
  },
  submit: {
    padding: 13, border: 0, borderRadius: 8,
    background: '#2563eb', color: '#ffffff',
    fontWeight: 600, fontSize: 14, cursor: 'pointer',
    marginTop: 4, transition: 'background-color 0.15s ease',
  },
  submitDisabled: {
    background: '#93c5fd',
    cursor: 'not-allowed',
  },
  errorBox: {
    color: '#b91c1c',
    background: '#fef2f2',
    border: '1px solid #fecaca',
    borderRadius: 8,
    padding: '10px 14px',
    fontSize: 13,
    lineHeight: 1.4,
  },
  toggleContainer: {
    marginTop: 24,
    textAlign: 'center',
    paddingTop: 16,
    borderTop: '1px solid #f2f4f7',
  },
  toggleText: {
    color: '#475467',
    fontSize: 14,
    margin: 0,
  },
  toggleLink: {
    background: 'none',
    border: 'none',
    padding: 0,
    color: '#2563eb',
    fontWeight: 600,
    fontSize: 14,
    cursor: 'pointer',
    textDecoration: 'underline',
  },
  footer: {
    color: '#98a2b3', fontSize: 12,
    textAlign: 'center', marginTop: 24,
  },
};
