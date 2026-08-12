import 'dotenv/config';
import { sequelize } from '../src/db/config.js';
import { User, Payout, Transaction, UserSubscription } from '../src/db/models.js';

const user = await User.findOne({ where: { email: 'demo@promptly.app' } });
if (!user) { console.log('no demo user'); process.exit(0); }
await UserSubscription.destroy({ where: { userId: user.id } });
await Payout.destroy({ where: { userId: user.id } });
await Transaction.destroy({ where: { userId: user.id } });
console.log('cleaned demo user test state');
await sequelize.close();
