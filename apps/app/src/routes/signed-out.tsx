import { Meta, Title } from "@solidjs/meta";

export default function SignedOut() {
  return (
    <main class="panel-page">
      <Title>Signed out | plansplease</Title>
      <Meta name="description" content="You have signed out of your plansplease workspace." />
      <p class="eyebrow">plansplease</p>
      <h1>You're signed out.</h1>
      <p class="panel-lede">Return to your workspace whenever you are ready.</p>
      <div class="panel-actions">
        <a class="button-primary" href="/auth/login">
          <span>Sign in</span>
        </a>
      </div>
    </main>
  );
}
