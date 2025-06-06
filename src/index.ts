// src/index.ts
import { Hono } from 'hono'
import { Resend } from 'resend'

type Bindings = {
  RESEND_API_KEY: string
  UPSTASH_REDIS_REST_URL: string
  UPSTASH_REDIS_REST_TOKEN: string
}

type EmailData = {
  to: string
  subject: string
  html: string
  from?: string
}

const app = new Hono<{ Bindings: Bindings }>()

// Redis response types
interface RedisResponse {
  result: any
  error?: string
}

// Redis client class for Upstash
class UpstashRedis {
  private url: string
  private token: string

  constructor(url: string, token: string) {
    this.url = url
    this.token = token
  }

  async request(command: string[]): Promise<RedisResponse> {
    const response = await fetch(`${this.url}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(command),
    })

    if (!response.ok) {
      throw new Error(`Redis request failed: ${response.statusText}`)
    }

    return response.json() as Promise<RedisResponse>
  }

  async lpush(key: string, value: string): Promise<RedisResponse> {
    return await this.request(['LPUSH', key, value])
  }

  async rpop(key: string): Promise<RedisResponse> {
    return await this.request(['RPOP', key])
  }

  async llen(key: string): Promise<RedisResponse> {
    return await this.request(['LLEN', key])
  }

  async exists(key: string): Promise<RedisResponse> {
    return await this.request(['EXISTS', key])
  }
}

// Initialize Resend and Redis
function initializeServices(env: Bindings) {
  const resend = new Resend(env.RESEND_API_KEY)
  const redis = new UpstashRedis(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN)
  return { resend, redis }
}

// Send email function
async function sendEmail(resend: Resend, emailData: EmailData) {
  try {
    const result = await resend.emails.send({
      from: emailData.from || 'onboarding@resend.dev',
      to: emailData.to,
      subject: emailData.subject,
      html: emailData.html,
    })

    return { success: true, data: result }
  } catch (error) {
    console.error('Email sending failed:', error)
    return { success: false, error: (error as Error).message }
  }
}

// Process email queue
async function processEmailQueue(resend: Resend, redis: UpstashRedis) {
  const QUEUE_KEY = 'email:queue'

  try {
    // Check if queue has items
    const queueLengthResponse = await redis.llen(QUEUE_KEY)
    const queueLength = queueLengthResponse.result as number

    if (!queueLength || queueLength === 0) {
      return { processed: 0, message: 'No emails in queue' }
    }

    let processed = 0
    const results = []

    // Process up to 10 emails at once
    for (let i = 0; i < Math.min(10, queueLength); i++) {
      const emailItemResponse = await redis.rpop(QUEUE_KEY)
      const emailItem = emailItemResponse.result as string | null

      if (!emailItem) break

      try {
        const emailData: EmailData = JSON.parse(emailItem)
        const sendResult = await sendEmail(resend, emailData)

        results.push({
          email: emailData.to,
          success: sendResult.success,
          error: sendResult.error || null
        })

        if (sendResult.success) {
          processed++
        }
      } catch (parseError) {
        console.error('Failed to parse email data:', parseError)
        results.push({
          email: 'unknown',
          success: false,
          error: 'Invalid email data format'
        })
      }
    }

    return { processed, results, total: queueLength }
  } catch (error) {
    console.error('Queue processing failed:', error)
    return { processed: 0, error: (error as Error).message }
  }
}

// Routes
app.get('/', (c) => {
  return c.json({
    message: 'Email Worker API',
    endpoints: {
      'POST /queue-email': 'Add email to queue',
      'POST /process-emails': 'Process email queue',
      'GET /queue-status': 'Check queue status',
      'POST /send-test': 'Send test email'
    }
  })
})

// Add email to queue
app.post('/queue-email', async (c) => {
  try {
    const { resend, redis } = initializeServices(c.env)
    const emailData: EmailData = await c.req.json()

    // Validate required fields
    if (!emailData.to || !emailData.subject || !emailData.html) {
      return c.json({ error: 'Missing required fields: to, subject, html' }, 400)
    }

    // Add to Redis queue
    const QUEUE_KEY = 'email:queue'
    await redis.lpush(QUEUE_KEY, JSON.stringify(emailData))

    return c.json({
      success: true,
      message: 'Email added to queue',
      data: emailData
    })
  } catch (error) {
    console.error('Queue email error:', error)
    return c.json({ error: 'Failed to queue email' }, 500)
  }
})

// Process emails in queue
app.post('/process-emails', async (c) => {
  try {
    const { resend, redis } = initializeServices(c.env)
    const result = await processEmailQueue(resend, redis)

    return c.json({
      success: true,
      ...result
    })
  } catch (error) {
    console.error('Process emails error:', error)
    return c.json({ error: 'Failed to process emails' }, 500)
  }
})

// Check queue status
app.get('/queue-status', async (c) => {
  try {
    const { redis } = initializeServices(c.env)
    const QUEUE_KEY = 'email:queue'

    const queueLengthResponse = await redis.llen(QUEUE_KEY)
    const queueLength = queueLengthResponse.result as number

    return c.json({
      success: true,
      queueLength: queueLength || 0,
      message: `${queueLength || 0} emails in queue`
    })
  } catch (error) {
    console.error('Queue status error:', error)
    return c.json({ error: 'Failed to get queue status' }, 500)
  }
})

// Send test email
app.post('/send-test', async (c) => {
  try {
    const { resend, redis } = initializeServices(c.env)
    const { email } = await c.req.json()

    if (!email) {
      return c.json({ error: 'Email address required' }, 400)
    }

    // Create test email
    const testEmailData: EmailData = {
      to: email,
      subject: 'Test Email from Email Worker',
      html: `
      <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #333;">
        <h1 style="color: #0070f3;">🚀 Kem Cho, Mitra?</h1>
        <p>આ મેસેજ એ બતાવવા માટે છે કે તમારું Email Worker <strong>બધુ જ સરસ ચાલી રહ્યું છે!</strong> 🎉</p>
        <p>આ ટેસ્ટ ઇમેઇલ પ્રેમથી અને થોડી ક્રિષ્ના ની કોડિંગ જાદૂથી મોકલાયું છે.</p>
        <blockquote style="border-left: 4px solid #0070f3; padding-left: 10px; color: #555;">
          "મહેનત કરો, ઝડપથી શિપ કરો અને મજા પણ કરો! 💻✨"
        </blockquote>
        <p>મોકલાયું છે: <em>${new Date().toLocaleString()}</em></p>
        <footer style="margin-top: 30px; font-size: 0.9em; color: #999;">
          — ક્રિષ્ના, તમરા ADSC ડેવલપર અને મિત્ર
        </footer>
      </div>
      `,
      from: 'noreply@adsc-atmiya.in'
    }

    // Add to queue and immediately process
    const QUEUE_KEY = 'email:queue'
    await redis.lpush(QUEUE_KEY, JSON.stringify(testEmailData))

    // Process the queue
    const processResult = await processEmailQueue(resend, redis)

    return c.json({
      success: true,
      message: 'Test email queued and processed',
      testEmail: email,
      processResult
    })
  } catch (error) {
    console.error('Send test error:', error)
    return c.json({ error: 'Failed to send test email' }, 500)
  }
})

// Scheduled handler for automatic email processing
export default {
  fetch: app.fetch,

  // This runs on a schedule (configure in wrangler.toml)
  async scheduled(event: any, env: Bindings, ctx: any) {
    console.log('Scheduled email processing triggered')

    const { resend, redis } = initializeServices(env)

    ctx.waitUntil((async () => {
      try {
        const result = await processEmailQueue(resend, redis)
        console.log('Scheduled processing result:', result)
      } catch (error) {
        console.error('Scheduled processing failed:', error)
      }
    })())
  }
}