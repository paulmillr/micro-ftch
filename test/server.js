const https = require('https');
const fs = require('fs');

/*
openssl ecparam -out ssl.key -name secp256r1 -genkey
openssl req -new -key ssl.key -out csr.pem
openssl req -x509 -nodes -days 3650 -key ssl.key -in csr.pem -out ssl.pem
rm csr.pem
*/
const CERT1 = {
  key: `-----BEGIN EC PARAMETERS-----
BggqhkjOPQMBBw==
-----END EC PARAMETERS-----
-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIIhg0dT/d+IJPsjolpeEEQ/0FTR3SQNurliLwyMiWlmSoAoGCCqGSM49
AwEHoUQDQgAEqSjaCBOf6gwtkO17yFBE7MJnd5Yz2SqzduO/LfhCz3qnL1exzqa0
D4vMKOo3CIgoeO1SwDiubtidwgQGilqTwQ==
-----END EC PRIVATE KEY-----`,
  cert: `-----BEGIN CERTIFICATE-----
MIIB2TCCAX+gAwIBAgIUfL9ZGZAEhoRj5MjED1e7fQhW+U8wCgYIKoZIzj0EAwIw
QjELMAkGA1UEBhMCWFgxFTATBgNVBAcMDERlZmF1bHQgQ2l0eTEcMBoGA1UECgwT
RGVmYXVsdCBDb21wYW55IEx0ZDAeFw0yMTA3MDUxMjIxMjBaFw0zMTA3MDMxMjIx
MjBaMEIxCzAJBgNVBAYTAlhYMRUwEwYDVQQHDAxEZWZhdWx0IENpdHkxHDAaBgNV
BAoME0RlZmF1bHQgQ29tcGFueSBMdGQwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNC
AASpKNoIE5/qDC2Q7XvIUETswmd3ljPZKrN2478t+ELPeqcvV7HOprQPi8wo6jcI
iCh47VLAOK5u2J3CBAaKWpPBo1MwUTAdBgNVHQ4EFgQUCpXvBkV3ifxoHS9jd7Mo
W8EUamAwHwYDVR0jBBgwFoAUCpXvBkV3ifxoHS9jd7MoW8EUamAwDwYDVR0TAQH/
BAUwAwEB/zAKBggqhkjOPQQDAgNIADBFAiEA91976QviVgC8HGyeJBCcdy3ceewI
NxNlyHUfPbl1HpACIFhbsPq93HkGnWBlsbmCP90oC/E3VufAduwKvLbiGVMk
-----END CERTIFICATE-----`,
};

const CERT2 = {
  key: `-----BEGIN EC PARAMETERS-----
BggqhkjOPQMBBw==
-----END EC PARAMETERS-----
-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIAjlYo3sU+8Xbfy1rUY0ce4yERujgw4gHo2gxaoyFwIMoAoGCCqGSM49
AwEHoUQDQgAEz9Xa6pHuNf+xPQJ5DYI4CIUg2nFOa/OjNisIfrPmrNE8RujaqA2+
3s9birYX2r/6xsdGEqRfnyJlHSAnewuPSg==
-----END EC PRIVATE KEY-----`,
  cert: `-----BEGIN CERTIFICATE-----
MIIB2TCCAX+gAwIBAgIUeuykJS3bsxC4jcKGAG1xa4yZLjwwCgYIKoZIzj0EAwIw
QjELMAkGA1UEBhMCWFgxFTATBgNVBAcMDERlZmF1bHQgQ2l0eTEcMBoGA1UECgwT
RGVmYXVsdCBDb21wYW55IEx0ZDAeFw0yMTA3MDUxMjIyMzJaFw0zMTA3MDMxMjIy
MzJaMEIxCzAJBgNVBAYTAlhYMRUwEwYDVQQHDAxEZWZhdWx0IENpdHkxHDAaBgNV
BAoME0RlZmF1bHQgQ29tcGFueSBMdGQwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNC
AATP1drqke41/7E9AnkNgjgIhSDacU5r86M2Kwh+s+as0TxG6NqoDb7ez1uKthfa
v/rGx0YSpF+fImUdICd7C49Ko1MwUTAdBgNVHQ4EFgQUZT84dGgM0yDfYl2BSWCI
w6+WJ48wHwYDVR0jBBgwFoAUZT84dGgM0yDfYl2BSWCIw6+WJ48wDwYDVR0TAQH/
BAUwAwEB/zAKBggqhkjOPQQDAgNIADBFAiAKv2YQ/2XCucgEeB7C1v5Xk1QHbHyu
OlRyUJ4TMN60vgIhAOa4z66VGV3WqjcuxhuDmFf6P/TvY33Ge6KRiNpEo317
-----END CERTIFICATE-----`,
};

const handler = (req, res) => {
  res.writeHead(200);
  res.end(JSON.stringify({ test: 'passed' }));
};
const startServer = (port, opt, fn) => https.createServer(opt, fn || handler).listen(port);

// 35dffeb2c0b774b6135523cf25bc6d5f24462975499beb5f7eae46f9bddc71b8
startServer(28001, { ...CERT1 });
// da5892edb1958c1652fa7f6d19da650312a3cce906ac529cf8830509f1c4b195
startServer(28002, { ...CERT2 });
