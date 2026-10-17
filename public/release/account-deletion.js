const descriptions = {
  REQUESTED: 'Request received; awaiting processing.',
  FILES_PENDING: 'Account removed; file cleanup is in progress.',
  EXTERNAL_REVIEW: 'Account removed; shared records and external services are under review. Deletion is not yet complete.',
  COMPLETE: 'Deletion review completed.',
};
async function post(route, body, token) {
  const response = await fetch(`/api/${route}`, { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Request failed. Check your details and try again.');
  return data;
}
function handle(id, output, action) {
  const form = document.getElementById(id);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = form.querySelector('button');
    button.disabled = true;
    const target = document.getElementById(output);
    target.textContent = 'Working…';
    try { target.textContent = await action(Object.fromEntries(new FormData(form))); }
    catch (error) { target.textContent = error.message; }
    finally { form.querySelectorAll('input[type=password]').forEach(input => { input.value = ''; }); button.disabled = false; }
  });
}
handle('request', 'result', async values => {
  if (values.confirmation !== 'DELETE') throw new Error('Type DELETE to confirm.');
  const job = await post('account-deletion/request-with-password', values);
  document.querySelector('#status input').value = job.receipt;
  return `${descriptions[job.status]} Save your private receipt: ${job.receipt}`;
});
handle('status', 'progress', async values => {
  const job = await post('account-deletion/status', values);
  return descriptions[job.status] || 'Contact support about this request.';
});
handle('recovery', 'recovery-result', async values => (await post('auth/forgot-password', values)).message);
handle('reset', 'recovery-result', async values => { await post('auth/reset-password', values); return 'Password updated. You can now request deletion above.'; });
