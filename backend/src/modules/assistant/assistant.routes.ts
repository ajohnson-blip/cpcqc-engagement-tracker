/**
 * Staff assistant endpoints. CPCQC staff only — these expose engagement
 * figures across every hospital, which is not a hospital-user view.
 *
 * Stateless: the client sends the conversation back each turn. Nothing is
 * persisted, so there is no chat history to leak or to keep in step with
 * hospital data changes. The numbers are reproducible from the tool trace,
 * which is what matters for a figure that ends up in a grant report.
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { requireAuth, requireStaff } from '@/middleware/auth.js';
import { assistantAvailable, runAssistant } from './assistant.service.js';

const router = Router();

// Each question can fan out into several model calls, so this is a cost
// control as much as an abuse control.
const chatLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

const ChatSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().min(1).max(8000),
      }),
    )
    .min(1)
    // A long thread is re-sent in full on every turn; the cap keeps one
    // conversation from growing into an expensive request.
    .max(40),
});

router.get('/status', requireAuth, requireStaff, (_req, res) => {
  res.json({ available: assistantAvailable() });
});

router.post('/chat', chatLimiter, requireAuth, requireStaff, async (req, res) => {
  const { messages } = ChatSchema.parse(req.body);
  const reply = await runAssistant(messages);
  res.json(reply);
});

export default router;
