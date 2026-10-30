'use strict';
const { encrypt, decrypt } = require('./streamlabs-auth');
const PATH = 'qss-overlay/streamlabs-oauth.enc.json';
function createStore() {
  return {
    async read() {
      try {
        const { get } = require('@vercel/blob');
        const result = await get(PATH, { access: 'private', useCache: false });
        if (!result) return {};
        if (result.statusCode !== 200) throw new Error();
        const value = await new Response(result.stream).json();
        return decrypt(value, process.env.QSS_STREAMLABS_ENCRYPTION_KEY);
      } catch { throw new Error('Could not open the saved Streamlabs connection settings.'); }
    },
    async write(value) {
      try {
        const { put } = require('@vercel/blob');
        const body = JSON.stringify(encrypt(value, process.env.QSS_STREAMLABS_ENCRYPTION_KEY));
        await put(PATH, body, { access: 'private', allowOverwrite: true, addRandomSuffix: false, contentType: 'application/json' });
      } catch { throw new Error('Could not save the encrypted Streamlabs connection settings.'); }
    }
  };
}
module.exports = { createStore };
