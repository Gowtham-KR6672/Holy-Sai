// Checks signS3 against AWS's published SigV4 example "GET Object" (S3 API reference, sig-v4-header-based-auth).
import { signS3 } from '../../apps/api/src/modules/integrations/s3';
// Usage (from the repo root): npx tsx tools/tests/s3-sign.test.ts

const auth = signS3(
  { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1' },
  {
    method: 'GET',
    url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
    headers: {
      range: 'bytes=0-9',
      'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      'x-amz-date': '20130524T000000Z',
    },
    payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    amzDate: '20130524T000000Z',
  },
);
const expected = 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41';
console.log(auth);
console.log(auth.endsWith(`Signature=${expected}`) ? 'PASS  signature matches the AWS example' : 'FAIL  signature differs');
