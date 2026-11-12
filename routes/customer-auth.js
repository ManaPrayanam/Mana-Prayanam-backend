const { createHash, randomBytes } = require('node:crypto');

const MOBILE_RE = /^[6-9]\d{9}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GENDERS = new Set(['woman', 'man', 'non_binary', 'prefer_not_to_say']);

function addCustomerAuth(router, pool) {
  async function verify(req, res, signup) {
    // Allow demo OTP when ENABLE_TEST_OTP=true (including Render production).
    if (process.env.ENABLE_TEST_OTP !== 'true') {
      return res.status(503).json({ error: 'Mobile verification is unavailable.' });
    }

    const { name, email, gender, mobile, otp } = req.body ?? {};
    if (typeof mobile !== 'string' || !MOBILE_RE.test(mobile)) {
      return res.status(400).json({ error: 'Enter a valid 10-digit Indian mobile number.' });
    }
    if (signup) {
      if (
        typeof name !== 'string' || !name.trim() || name.trim().length > 120 || name.includes('\0') ||
        typeof email !== 'string' || email.trim().length > 254 || email.includes('\0') ||
        !EMAIL_RE.test(email.trim()) ||
        !GENDERS.has(gender)
      ) {
        return res.status(400).json({ error: 'Enter your name, email, and gender.' });
      }
    }
    if (otp !== '1234') return res.status(400).json({ error: 'Incorrect verification code.' });

    const token = randomBytes(32).toString('hex');
    const hash = createHash('sha256').update(token).digest('hex');
    const account = signup
      ? `INSERT INTO public.users (name, email, gender, mobile, mobile_verified_at, role)
         VALUES ($3, $4, $5, $2, now(), 'rider')
         ON CONFLICT DO NOTHING
         RETURNING id, name, email, gender, mobile, role`
      : `SELECT id, name, email, gender, mobile, role FROM public.users
         WHERE mobile = $2 AND mobile_verified_at IS NOT NULL AND role = 'rider'`;
    const values = signup
      ? [hash, mobile, name.trim(), email.trim().toLowerCase(), gender]
      : [hash, mobile];

    const { rows: [user] } = await pool.query(`
      WITH account AS (${account}),
      session AS (
        INSERT INTO public.sessions (token_hash, user_id, expires_at)
        SELECT $1, id, now() + interval '1 day' FROM account
      )
      SELECT * FROM account
    `, values);

    if (!user) {
      return res.status(signup ? 409 : 401).json({
        error: signup
          ? 'An account already uses this email or mobile number. Log in with that mobile instead.'
          : 'No account found for this mobile number. Create an account first.',
      });
    }

    res.set('Cache-Control', 'no-store');
    res.status(signup ? 201 : 200).json({
      token,
      expiresIn: 86400,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        gender: user.gender,
        mobile: user.mobile,
        role: user.role,
      },
    });
  }

  router.post('/auth/customer/check-mobile', async (req, res) => {
    const { mobile } = req.body ?? {};
    if (typeof mobile !== 'string' || !MOBILE_RE.test(mobile)) {
      return res.status(400).json({ error: 'Enter a valid 10-digit Indian mobile number.' });
    }
    const { rows } = await pool.query(
      `SELECT 1 FROM public.users
       WHERE mobile = $1 AND mobile_verified_at IS NOT NULL AND role = 'rider'
       LIMIT 1`,
      [mobile],
    );
    res.set('Cache-Control', 'no-store');
    res.json({ exists: rows.length > 0 });
  });

  router.post('/auth/customer/signup', (req, res) => verify(req, res, true));
  router.post('/auth/customer/login', (req, res) => verify(req, res, false));
}

module.exports = { addCustomerAuth };
