'use client';

import { useEffect } from 'react';
import { InstallAppButton } from './pwa-support';
import { ArrowRight, ArrowUpRight, Building2, Check, CircleAlert, ShieldCheck, Truck, Wallet } from 'lucide-react';
import { GoogleAuthForm, GoogleMark, SignOutForm } from './auth-controls';
import './auth-page.css';

type AuthPageProps = {
  mode: 'login' | 'signup';
  error?: string;
  resetRequired?: boolean;
  googleConfigured?: boolean;
};

export function AuthPage({ mode, error, resetRequired = false, googleConfigured = true }: AuthPageProps) {
  const signup = mode === 'signup';

  useEffect(() => {
    document.documentElement.dataset.theme = localStorage.getItem('hisab-theme') === 'dark' ? 'dark' : 'light';
  }, []);

  return <main className="auth-page">
    <section className="auth-entry" aria-labelledby="auth-page-heading">
      <header className="auth-page-header">
        <a className="auth-page-brand" href="/login" aria-label="HisabFlow sign in"><img src="/favicon.svg" width="42" height="42" alt=""/></a>
        <p>{signup ? 'Already have an account?' : 'New here?'}<a href={signup ? '/login' : '/signup'}>{signup ? 'Sign in' : 'Create account'}<ArrowUpRight size={14}/></a></p>
      </header>

      <div className="auth-entry-content">
        <span className="auth-page-eyebrow"><span/> YOUR BUSINESS, IN BALANCE</span>
        <h1 id="auth-page-heading">{signup ? 'Create your workspace.' : 'Welcome back.'}</h1>
        <p className="auth-page-intro">{signup ? 'A clear start for your business. Create your private workspace with your Google account.' : 'Sign in to your private workspace. Your business, right where you left it.'}</p>

        {(error || !googleConfigured) && <div className="auth-page-error" role="alert"><CircleAlert size={19}/><div><b>{googleConfigured ? 'Let’s try that again.' : 'Sign-in is unavailable.'}</b><p>{error || 'Please try again shortly.'}</p>{resetRequired && <SignOutForm reset/>}</div></div>}

        <div className="auth-page-action">
          {googleConfigured ? <GoogleAuthForm label={signup ? 'Create account with Google' : 'Continue with Google'}/> : <button className="button google-auth-button full-width" disabled><GoogleMark/>Continue with Google</button>}
        </div>

        <p className="auth-page-account-link">{signup ? 'Already have a workspace?' : 'Starting something new?'} <a href={signup ? '/login' : '/signup'}>{signup ? 'Sign in' : 'Create an account'}<ArrowRight size={14}/></a></p>
        <InstallAppButton className="hf-auth-install"/><div className="auth-page-assurance"><span><ShieldCheck size={17}/></span><p>{signup ? 'Your business records start with you.' : 'A private space for your business.'}<small>Secure sign-in with your Google account.</small></p></div>
      </div>

      <footer className="auth-page-footer"><span>Clarity in every entry.</span><span className="auth-page-footer-mark">Made for your everyday business<span>✳</span></span></footer>
    </section>

    <aside className="auth-story" aria-label="Your business workspace">
      <div className="auth-story-art" aria-hidden="true">
        <div className="auth-art-orbit auth-art-orbit-one"/>
        <div className="auth-art-orbit auth-art-orbit-two"/>
        <div className="auth-art-line auth-art-line-one"/>
        <div className="auth-art-line auth-art-line-two"/>
        <div className="auth-art-logo"><img src="/favicon.svg" width="72" height="72" alt=""/><span><Check size={16}/></span></div>
        <div className="auth-art-label auth-art-companies"><span><Building2 size={19}/></span><b>Companies</b><Check size={15}/></div>
        <div className="auth-art-label auth-art-deliveries"><span><Truck size={19}/></span><b>Deliveries</b><Check size={15}/></div>
        <div className="auth-art-label auth-art-payments"><span><Wallet size={19}/></span><b>Payments</b><Check size={15}/></div>
        <span className="auth-art-spark auth-art-spark-one">✳</span><span className="auth-art-spark auth-art-spark-two">✳</span>
      </div>
      <div className="auth-story-copy"><span className="auth-story-eyebrow">A LITTLE CLARITY GOES A LONG WAY</span><h2>Good business.<br/>A clearer picture.</h2><p>Keep your companies, deliveries, and payments together. Make room for what’s next.</p></div>
      <span className="auth-story-bottom"><span/>One organized workspace.</span>
    </aside>
  </main>;
}
