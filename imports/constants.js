import { DDP } from 'meteor/ddp';

export const KAKO_SELECTOR = { 'twitter.profile.screen_name': 'twiigo2015' };
export const twiigo = DDP.connect('http://localhost:3000');
export const dbOptions = { connection: twiigo };
