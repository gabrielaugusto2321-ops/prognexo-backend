import express from 'express';
import cors from 'cors';
import 'dotenv/config';

import leadsRoutes from './routes/leads.js';
import dealsRoutes from './routes/deals.js';
import dashboardRoutes from './routes/dashboard.js';
import teamRoutes from './routes/team.js';
import doctorsRoutes from './routes/doctors.js';
import signupRoutes from './routes/signup.js';
import integrationsRoutes from './routes/integrations.js';
import jobsRoutes from './routes/jobs.js';
import eventsRoutes from './routes/events.js';
import googleAuthRoutes from './routes/googleAuth.js';
import reportsRoutes from './routes/reports.js';
import whatsappWebhook from './webhooks/whatsapp.js';
import pagarmeWebhook from './webhooks/pagarme.js';
import kiwifyWebhook from './webhooks/kiwify.js';
import hotmartWebhook from './webhooks/hotmart.js';
import tictoWebhook from './webhooks/ticto.js';

const app = express();
app.use(cors());
app.use(express.json());

// Log simples de toda requisição recebida — ajuda a confirmar que os
// webhooks das plataformas de venda estão realmente chegando aqui.
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

app.use('/leads', leadsRoutes);
app.use('/deals', dealsRoutes);
app.use('/dashboard', dashboardRoutes);
app.use('/team', teamRoutes);
app.use('/doctors', doctorsRoutes);
app.use('/signup', signupRoutes);
app.use('/integrations', integrationsRoutes);
app.use('/jobs', jobsRoutes);
app.use('/events', eventsRoutes);
app.use('/auth/google', googleAuthRoutes);
app.use('/reports', reportsRoutes);
app.use('/webhooks/whatsapp', whatsappWebhook);
app.use('/webhooks/pagarme', pagarmeWebhook);
app.use('/webhooks/kiwify', kiwifyWebhook);
app.use('/webhooks/hotmart', hotmartWebhook);
app.use('/webhooks/ticto', tictoWebhook);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3333;
app.listen(PORT, () => console.log(`Prognexo backend rodando na porta ${PORT}`));
