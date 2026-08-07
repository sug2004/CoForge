import {
  Controller,
  Get,
  Post,
  Body,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';

import { GithubAuthGuard } from './github/github-auth.guard';
import { JwtAuthGuard } from './jwt/jwt-auth.guard';
import { AuthService } from './auth.service';

@Controller()
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('auth/register')
  async register(
    @Body() body: { username: string; email: string; password: string },
    @Res() res: Response,
  ) {
    const { accessToken, user } = await this.authService.register(
      body.username,
      body.email,
      body.password,
    );
    res
      .cookie('token', accessToken, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
      })
      .json({ user });
  }

  @Post('auth/login')
  async login(
    @Body() body: { email: string; password: string },
    @Res() res: Response,
  ) {
    const { accessToken, user } = await this.authService.login(
      body.email,
      body.password,
    );
    res
      .cookie('token', accessToken, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
      })
      .json({ user });
  }

  @Get('auth/github')
  @UseGuards(GithubAuthGuard)
  githubLogin() {}

  @Get('auth/github/callback')
  @UseGuards(GithubAuthGuard)
  async githubCallback(@Req() req, @Res() res: Response) {
    const { accessToken } = await this.authService.validateGithubUser(req.user);
    res
      .cookie('token', accessToken, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
      })
      .redirect(process.env.FRONTEND_URL + '/dashboard');
  }

  @Get('auth/github/link')
  @UseGuards(JwtAuthGuard, GithubAuthGuard)
  githubLinkInit() {}

  @Get('auth/github/link/callback')
  @UseGuards(JwtAuthGuard, GithubAuthGuard)
  async githubLinkCallback(@Req() req, @Res() res: Response) {
    await this.authService.linkGithub(req.user.id, req.user);
    res.redirect(process.env.FRONTEND_URL + '/dashboard');
  }

  @Get('auth/logout')
  logout(@Res() res: Response) {
    res.clearCookie('token').redirect(process.env.FRONTEND_URL + '/login');
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@Req() req) {
    return req.user;
  }

  @Get('me/token')
  @UseGuards(JwtAuthGuard)
  async meToken(@Req() req: { user: { id: string; username: string } }) {
    const accessToken = await this.authService.issueToken(req.user);
    return { accessToken };
  }
}
