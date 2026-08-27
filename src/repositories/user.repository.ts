import { prisma } from '../config/database';
import { AuthUser } from '../types';

class UserRepository {
  async findByEmail(email: string) {
    return prisma.user.findUnique({ where: { email } });
  }

  async findById(id: string): Promise<AuthUser | null> {
    const user = await prisma.user.findUnique({ where: { id }, select: { id: true, email: true } });
    return user;
  }

  async create(email: string, passwordHash: string) {
    return prisma.user.create({ data: { email, passwordHash } });
  }
}

export default new UserRepository();
